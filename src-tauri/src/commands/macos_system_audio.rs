#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{c_void, CStr};
    use std::mem::{size_of, MaybeUninit};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::ptr::{self, NonNull};

    use objc2::{exception, AnyThread};
    use objc2_core_audio::{
        AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
        AudioDeviceStart, AudioDeviceStop,
        AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
        AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData,
        AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
        kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
        kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
        kAudioAggregateDeviceUIDKey, kAudioHardwareNoError, kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        kAudioObjectUnknown, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, kAudioTapPropertyFormat,
    };
    use objc2_core_audio_types::{
        AudioBuffer, AudioBufferList, AudioStreamBasicDescription,
        kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsSignedInteger,
        kAudioFormatLinearPCM,
    };
    use objc2_core_foundation::{
        CFArray, CFDictionary, CFMutableDictionary, CFNumber, CFRetained, CFString, CFType,
    };
    use objc2_foundation::{NSArray, NSNumber};
    use tokio::sync::mpsc;

    const TARGET_SAMPLE_RATE: f64 = 16_000.0;

    pub struct NativeSystemAudioCapture {
        aggregate_device_id: AudioObjectID,
        tap_id: AudioObjectID,
        io_proc_id: AudioDeviceIOProcID,
        callback_ctx: *mut CallbackCtx,
        stopped: bool,
    }

    // The raw pointer is exclusively owned by this struct and freed on stop/drop.
    unsafe impl Send for NativeSystemAudioCapture {}

    struct CallbackCtx {
        audio_tx: mpsc::Sender<Vec<u8>>,
        input_format: InputFormat,
        resampler: LinearResampler,
    }

    #[derive(Clone, Copy, Debug)]
    struct InputFormat {
        sample_rate: f64,
        channels: usize,
        bytes_per_sample: usize,
        bytes_per_frame: usize,
        non_interleaved: bool,
        is_float: bool,
        is_signed_integer: bool,
    }

    impl InputFormat {
        fn from_asbd(asbd: AudioStreamBasicDescription) -> Result<Self, String> {
            let channels = asbd.mChannelsPerFrame.max(1) as usize;
            let bits_per_channel = asbd.mBitsPerChannel.max(16);
            let bytes_per_sample = ((bits_per_channel + 7) / 8) as usize;
            let bytes_per_frame = if asbd.mBytesPerFrame > 0 {
                asbd.mBytesPerFrame as usize
            } else {
                bytes_per_sample.saturating_mul(channels)
            };
            let non_interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
            let is_float = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
            let is_signed_integer = (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;

            if asbd.mSampleRate <= 0.0 {
                return Err("Invalid system audio sample rate from Process Tap.".to_string());
            }
            if asbd.mFormatID != kAudioFormatLinearPCM {
                return Err(format!(
                    "Unsupported Process Tap format id: 0x{:x} (expected linear PCM).",
                    asbd.mFormatID
                ));
            }
            if !is_float && !is_signed_integer {
                return Err(format!(
                    "Unsupported Process Tap sample format flags: 0x{:x}",
                    asbd.mFormatFlags
                ));
            }

            Ok(Self {
                sample_rate: asbd.mSampleRate,
                channels,
                bytes_per_sample,
                bytes_per_frame,
                non_interleaved,
                is_float,
                is_signed_integer,
            })
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct LinearResampler {
        ratio: f64,
        input_pos: f64,
        next_out_pos: f64,
        prev: f32,
        has_prev: bool,
    }

    impl LinearResampler {
        fn new(input_sample_rate: f64) -> Self {
            Self {
                ratio: input_sample_rate / TARGET_SAMPLE_RATE,
                input_pos: 0.0,
                next_out_pos: 0.0,
                prev: 0.0,
                has_prev: false,
            }
        }

        fn push(&mut self, sample: f32, out: &mut Vec<i16>) {
            if !self.has_prev {
                self.prev = sample;
                self.has_prev = true;
                self.input_pos = 1.0;
                return;
            }

            let curr_idx = self.input_pos;
            let left_idx = curr_idx - 1.0;
            while self.next_out_pos <= curr_idx {
                let frac = (self.next_out_pos - left_idx) as f32;
                let mixed = self.prev + (sample - self.prev) * frac.clamp(0.0, 1.0);
                out.push(float_to_i16(mixed));
                self.next_out_pos += self.ratio;
            }
            self.prev = sample;
            self.input_pos += 1.0;

            // Keep indexes bounded to avoid losing precision in long sessions.
            if self.input_pos > 1_000_000.0 {
                let shift = self.input_pos.floor() - 1.0;
                self.input_pos -= shift;
                self.next_out_pos -= shift;
            }
        }
    }

    impl NativeSystemAudioCapture {
        pub fn start(audio_tx: mpsc::Sender<Vec<u8>>, session_id: &str) -> Result<Self, String> {
            log_step("start", "creating process tap");
            let excluded_process = translate_pid_to_process_object(std::process::id() as i32)?;
            let excluded = if let Some(process_object_id) = excluded_process {
                NSArray::from_retained_slice(&[NSNumber::new_u32(process_object_id)])
            } else {
                NSArray::from_retained_slice(&[])
            };
            let tap_description = objc_try(
                "CATapDescription::initMonoGlobalTapButExcludeProcesses",
                || unsafe {
                    CATapDescription::initMonoGlobalTapButExcludeProcesses(
                        CATapDescription::alloc(),
                        &excluded,
                    )
                },
            )?;
            objc_try("CATapDescription configuration", || unsafe {
                tap_description.setPrivate(true);
                tap_description.setMuteBehavior(CATapMuteBehavior::Unmuted);
            })?;
            let tap_uid =
                objc_try("CATapDescription::UUID", || unsafe { tap_description.UUID().UUIDString().to_string() })?;
            let tap_uid_cf = CFString::from_str(&tap_uid);

            let mut tap_id: AudioObjectID = kAudioObjectUnknown;
            let tap_status = objc_try("AudioHardwareCreateProcessTap", || unsafe {
                AudioHardwareCreateProcessTap(Some(&tap_description), &mut tap_id)
            })?;
            if tap_status != kAudioHardwareNoError {
                return Err(format!(
                    "AudioHardwareCreateProcessTap failed: {}.",
                    os_status_text(tap_status)
                ));
            }

            let input_asbd: AudioStreamBasicDescription = match read_property(
                tap_id,
                kAudioTapPropertyFormat,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain as u32,
                "kAudioTapPropertyFormat",
            ) {
                Ok(v) => v,
                Err(e) => {
                    let _ = unsafe { AudioHardwareDestroyProcessTap(tap_id) };
                    return Err(e);
                }
            };
            let input_format = match InputFormat::from_asbd(input_asbd) {
                Ok(v) => v,
                Err(e) => {
                    let _ = unsafe { AudioHardwareDestroyProcessTap(tap_id) };
                    return Err(e);
                }
            };

            let aggregate_device_uid = CFString::from_str(&format!("com.moraya.systemtap.{}", session_id));
            let aggregate_device_name = CFString::from_str("Moraya System Audio Tap");

            let sub_tap_key = cf_key(kAudioSubTapUIDKey);
            let sub_tap_drift_key = cf_key(kAudioSubTapDriftCompensationKey);
            let tap_uid_cf_type: &CFType = tap_uid_cf.as_ref();
            let drift_enabled = CFNumber::new_i32(1);
            let drift_enabled_cf: &CFType = drift_enabled.as_ref();
            let sub_tap = CFDictionary::<CFString, CFType>::from_slices(
                &[sub_tap_key.as_ref(), sub_tap_drift_key.as_ref()],
                &[tap_uid_cf_type, drift_enabled_cf],
            );
            let tap_list = CFArray::<CFDictionary>::from_objects(&[sub_tap.as_ref()]);

            let desc = CFMutableDictionary::<CFString, CFType>::empty();
            let aggregate_name_cf: &CFType = aggregate_device_name.as_ref();
            let aggregate_uid_cf: &CFType = aggregate_device_uid.as_ref();
            let bool_true_cf = CFNumber::new_i32(1);
            let bool_true_cf: &CFType = bool_true_cf.as_ref();
            let tap_list_cf: &CFType = tap_list.as_ref();
            desc.set(&cf_key(kAudioAggregateDeviceNameKey), aggregate_name_cf);
            desc.set(&cf_key(kAudioAggregateDeviceUIDKey), aggregate_uid_cf);
            desc.set(
                &cf_key(kAudioAggregateDeviceIsPrivateKey),
                bool_true_cf,
            );
            desc.set(
                &cf_key(kAudioAggregateDeviceTapAutoStartKey),
                bool_true_cf,
            );
            desc.set(
                &cf_key(kAudioAggregateDeviceTapListKey),
                tap_list_cf,
            );
            let desc_mut_ref: &CFMutableDictionary<CFString, CFType> = desc.as_ref();
            let desc_dict_ref: &CFDictionary<CFString, CFType> = desc_mut_ref.as_ref();

            let mut aggregate_device_id: AudioObjectID = kAudioObjectUnknown;
            log_step("start", "creating aggregate device");
            let aggregate_status = objc_try("AudioHardwareCreateAggregateDevice", || unsafe {
                AudioHardwareCreateAggregateDevice(
                    desc_dict_ref.as_ref(),
                    NonNull::from(&mut aggregate_device_id),
                )
            })?;
            if aggregate_status != kAudioHardwareNoError {
                let _ = unsafe { AudioHardwareDestroyProcessTap(tap_id) };
                return Err(format!(
                    "AudioHardwareCreateAggregateDevice failed: {}.",
                    os_status_text(aggregate_status)
                ));
            }

            let callback_ctx = Box::into_raw(Box::new(CallbackCtx {
                audio_tx,
                input_format,
                resampler: LinearResampler::new(input_format.sample_rate),
            }));

            let mut io_proc_id: AudioDeviceIOProcID = None;
            let create_proc_status = unsafe {
                AudioDeviceCreateIOProcID(
                    aggregate_device_id,
                    Some(system_audio_ioproc),
                    callback_ctx.cast::<c_void>(),
                    NonNull::from(&mut io_proc_id),
                )
            };
            if create_proc_status != kAudioHardwareNoError {
                unsafe {
                    drop(Box::from_raw(callback_ctx));
                    let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
                    let _ = AudioHardwareDestroyProcessTap(tap_id);
                }
                return Err(format!(
                    "AudioDeviceCreateIOProcID failed: {}.",
                    os_status_text(create_proc_status)
                ));
            }

            let start_status = unsafe { AudioDeviceStart(aggregate_device_id, io_proc_id) };
            if start_status != kAudioHardwareNoError {
                unsafe {
                    let _ = AudioDeviceDestroyIOProcID(aggregate_device_id, io_proc_id);
                    drop(Box::from_raw(callback_ctx));
                    let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
                    let _ = AudioHardwareDestroyProcessTap(tap_id);
                }
                return Err(format!(
                    "AudioDeviceStart failed: {}.",
                    os_status_text(start_status)
                ));
            }

            log_step("start", "system audio capture active");

            Ok(Self {
                aggregate_device_id,
                tap_id,
                io_proc_id,
                callback_ctx,
                stopped: false,
            })
        }

        pub fn stop(&mut self) {
            if self.stopped {
                return;
            }
            self.stopped = true;
            unsafe {
                let _ = AudioDeviceStop(self.aggregate_device_id, self.io_proc_id);
                let _ = AudioDeviceDestroyIOProcID(self.aggregate_device_id, self.io_proc_id);
                let _ = AudioHardwareDestroyAggregateDevice(self.aggregate_device_id);
                let _ = AudioHardwareDestroyProcessTap(self.tap_id);
                if !self.callback_ctx.is_null() {
                    drop(Box::from_raw(self.callback_ctx));
                    self.callback_ctx = ptr::null_mut();
                }
            }
        }
    }

    impl Drop for NativeSystemAudioCapture {
        fn drop(&mut self) {
            self.stop();
        }
    }

    unsafe extern "C-unwind" fn system_audio_ioproc(
        _in_device: AudioObjectID,
        _in_now: NonNull<objc2_core_audio_types::AudioTimeStamp>,
        in_input_data: NonNull<AudioBufferList>,
        _in_input_time: NonNull<objc2_core_audio_types::AudioTimeStamp>,
        out_output_data: NonNull<AudioBufferList>,
        _in_output_time: NonNull<objc2_core_audio_types::AudioTimeStamp>,
        in_client_data: *mut c_void,
    ) -> i32 {
        if in_client_data.is_null() {
            return 0;
        }
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
            let ctx = &mut *(in_client_data as *mut CallbackCtx);

            let input_buffers = audio_buffers_from_list(in_input_data);
            let mut out_samples = Vec::<i16>::with_capacity(2048);
            collect_mono_pcm16(input_buffers, ctx, &mut out_samples);

            if !out_samples.is_empty() {
                let mut bytes = Vec::<u8>::with_capacity(out_samples.len() * 2);
                for sample in out_samples {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                let _ = ctx.audio_tx.try_send(bytes);
            }

            // Aggregate tap device has no output path for us. Keep output empty.
            let output_ptr = out_output_data.as_ptr();
            let output_count = (*output_ptr).mNumberBuffers as usize;
            let output_base = (*output_ptr).mBuffers.as_mut_ptr();
            for idx in 0..output_count {
                let out_buf = &mut *output_base.add(idx);
                out_buf.mDataByteSize = 0;
            }
        }))
        .map_err(|_| log_step("callback", "panic suppressed in system audio callback"));

        0
    }

    fn collect_mono_pcm16(buffers: Vec<AudioBuffer>, ctx: &mut CallbackCtx, out: &mut Vec<i16>) {
        if buffers.is_empty() {
            return;
        }
        let fmt = ctx.input_format;
        if fmt.channels == 0 || fmt.bytes_per_sample == 0 {
            return;
        }

        let channel_count = fmt.channels.min(buffers.len().max(1));
        if fmt.non_interleaved {
            let mut frame_count = usize::MAX;
            for buf in buffers.iter().take(channel_count) {
                if buf.mData.is_null() {
                    return;
                }
                frame_count = frame_count.min((buf.mDataByteSize as usize) / fmt.bytes_per_sample);
            }
            if frame_count == usize::MAX {
                return;
            }
            for frame in 0..frame_count {
                let mut mixed = 0.0f32;
                let mut used = 0usize;
                for buf in buffers.iter().take(channel_count) {
                    let bytes = unsafe {
                        std::slice::from_raw_parts(buf.mData as *const u8, buf.mDataByteSize as usize)
                    };
                    let offset = frame * fmt.bytes_per_sample;
                    if let Some(sample) = decode_sample(bytes, offset, &fmt) {
                        mixed += sample;
                        used += 1;
                    }
                }
                if used > 0 {
                    ctx.resampler.push(mixed / used as f32, out);
                }
            }
        } else {
            let buf = &buffers[0];
            if buf.mData.is_null() {
                return;
            }
            let bytes = unsafe { std::slice::from_raw_parts(buf.mData as *const u8, buf.mDataByteSize as usize) };
            let bytes_per_frame = fmt.bytes_per_frame.max(fmt.bytes_per_sample * fmt.channels);
            if bytes_per_frame == 0 {
                return;
            }
            let frame_count = bytes.len() / bytes_per_frame;
            for frame in 0..frame_count {
                let mut mixed = 0.0f32;
                let mut used = 0usize;
                for ch in 0..fmt.channels {
                    let offset = frame
                        .saturating_mul(bytes_per_frame)
                        .saturating_add(ch.saturating_mul(fmt.bytes_per_sample));
                    if let Some(sample) = decode_sample(bytes, offset, &fmt) {
                        mixed += sample;
                        used += 1;
                    }
                }
                if used > 0 {
                    ctx.resampler.push(mixed / used as f32, out);
                }
            }
        }
    }

    fn audio_buffers_from_list(list: NonNull<AudioBufferList>) -> Vec<AudioBuffer> {
        unsafe {
            let ptr = list.as_ptr();
            let count = (*ptr).mNumberBuffers as usize;
            let base = (*ptr).mBuffers.as_ptr();
            let mut buffers = Vec::with_capacity(count);
            for idx in 0..count {
                buffers.push(*base.add(idx));
            }
            buffers
        }
    }

    fn decode_sample(bytes: &[u8], offset: usize, fmt: &InputFormat) -> Option<f32> {
        let bps = fmt.bytes_per_sample;
        if offset.checked_add(bps)? > bytes.len() {
            return None;
        }
        let sample = if fmt.is_float {
            match bps {
                4 => {
                    let mut raw = [0u8; 4];
                    raw.copy_from_slice(&bytes[offset..offset + 4]);
                    f32::from_le_bytes(raw)
                }
                8 => {
                    let mut raw = [0u8; 8];
                    raw.copy_from_slice(&bytes[offset..offset + 8]);
                    f64::from_le_bytes(raw) as f32
                }
                _ => return None,
            }
        } else if fmt.is_signed_integer {
            match bps {
                2 => {
                    let mut raw = [0u8; 2];
                    raw.copy_from_slice(&bytes[offset..offset + 2]);
                    i16::from_le_bytes(raw) as f32 / i16::MAX as f32
                }
                3 => {
                    let b0 = bytes[offset] as i32;
                    let b1 = bytes[offset + 1] as i32;
                    let b2 = bytes[offset + 2] as i32;
                    let signed = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
                    signed as f32 / 8_388_607.0
                }
                4 => {
                    let mut raw = [0u8; 4];
                    raw.copy_from_slice(&bytes[offset..offset + 4]);
                    i32::from_le_bytes(raw) as f32 / i32::MAX as f32
                }
                _ => return None,
            }
        } else {
            return None;
        };
        Some(sample.clamp(-1.0, 1.0))
    }

    fn float_to_i16(value: f32) -> i16 {
        let v = value.clamp(-1.0, 1.0);
        (v * i16::MAX as f32).round() as i16
    }

    fn cf_key(key: &CStr) -> CFRetained<CFString> {
        CFString::from_str(key.to_str().unwrap_or_default())
    }

    fn read_property<T: Copy>(
        object_id: AudioObjectID,
        selector: u32,
        scope: u32,
        element: u32,
        name: &str,
    ) -> Result<T, String> {
        read_property_with_qualifier::<T, ()>(object_id, selector, scope, element, None, name)
    }

    fn read_property_with_qualifier<T: Copy, Q: Copy>(
        object_id: AudioObjectID,
        selector: u32,
        scope: u32,
        element: u32,
        qualifier: Option<&Q>,
        name: &str,
    ) -> Result<T, String> {
        let mut address = AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        };
        let (qualifier_size, qualifier_ptr) = match qualifier {
            Some(value) => (
                size_of::<Q>() as u32,
                value as *const Q as *const c_void,
            ),
            None => (0, ptr::null()),
        };
        let mut data_size = size_of::<T>() as u32;
        let mut value = MaybeUninit::<T>::uninit();
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                NonNull::from(&mut address),
                qualifier_size,
                qualifier_ptr,
                NonNull::from(&mut data_size),
                NonNull::new_unchecked(value.as_mut_ptr() as *mut c_void),
            )
        };
        if status != kAudioHardwareNoError {
            return Err(format!("{} failed: {}.", name, os_status_text(status)));
        }
        if data_size < size_of::<T>() as u32 {
            return Err(format!(
                "{} returned short data: {} bytes (expected >= {}).",
                name,
                data_size,
                size_of::<T>()
            ));
        }
        Ok(unsafe { value.assume_init() })
    }

    fn translate_pid_to_process_object(pid: i32) -> Result<Option<AudioObjectID>, String> {
        let process_object_id: AudioObjectID = read_property_with_qualifier(
            kAudioObjectSystemObject as AudioObjectID,
            kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain as u32,
            Some(&pid),
            "kAudioHardwarePropertyTranslatePIDToProcessObject",
        )?;
        if process_object_id == kAudioObjectUnknown {
            log_step("start", "current pid has no CoreAudio process object; creating unfiltered tap");
            Ok(None)
        } else {
            Ok(Some(process_object_id))
        }
    }

    fn os_status_text(status: i32) -> String {
        let bytes = status.to_be_bytes();
        let is_fourcc = bytes
            .iter()
            .all(|b| b.is_ascii_graphic() || *b == b' ');
        if is_fourcc {
            format!("{status} ('{}')", String::from_utf8_lossy(&bytes))
        } else {
            status.to_string()
        }
    }

    fn objc_try<T>(
        step: &str,
        f: impl FnOnce() -> T,
    ) -> Result<T, String> {
        exception::catch(AssertUnwindSafe(f)).map_err(|err| {
            let detail = err
                .as_deref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "unknown Objective-C exception".to_string());
            format!("{step} raised an Objective-C exception: {detail}.")
        })
    }

    fn log_step(step: &str, message: &str) {
        eprintln!("[macos_system_audio:{step}] {message}");
    }
}

#[cfg(target_os = "macos")]
pub use imp::NativeSystemAudioCapture;

#[cfg(not(target_os = "macos"))]
pub struct NativeSystemAudioCapture;

#[cfg(not(target_os = "macos"))]
impl NativeSystemAudioCapture {
    pub fn start(
        _audio_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
        _session_id: &str,
    ) -> Result<Self, String> {
        Err("Native system audio capture is only available on macOS.".to_string())
    }

    pub fn stop(&mut self) {}
}
