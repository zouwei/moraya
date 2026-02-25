/**
 * Object Storage Upload Command
 *
 * Implements HMAC-signed uploads for cloud object storage providers:
 * - Qiniu Kodo (HMAC-SHA1 upload token)
 * - Aliyun OSS (HMAC-SHA1 Authorization)
 * - Tencent COS (HMAC-SHA1 q-sign-algorithm)
 * - AWS S3 (HMAC-SHA256 SigV4)
 * - Google Cloud Storage (HMAC-SHA256 V4)
 *
 * API keys are passed from the frontend (already retrieved from keychain or
 * entered by the user) and never stored in plaintext on disk.
 */

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use hex;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::command;

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

// ── HMAC helpers ──────────────────────────────────────────────────────────────

fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha1::new_from_slice(key).expect("HMAC-SHA1 key length valid");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 key length valid");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn base64_std(data: &[u8]) -> String {
    general_purpose::STANDARD.encode(data)
}

fn base64_url(data: &[u8]) -> String {
    general_purpose::URL_SAFE.encode(data)
}

// ── Qiniu Kodo ────────────────────────────────────────────────────────────────

fn qiniu_upload_endpoint(region: &str) -> &'static str {
    match region {
        "z0" | "cn-east-1" => "https://up.qiniup.com",
        "z1" | "cn-north-1" => "https://up-z1.qiniup.com",
        "z2" | "cn-south-1" => "https://up-z2.qiniup.com",
        "na0" | "us-north-1" => "https://up-na0.qiniup.com",
        "as0" | "ap-southeast-1" => "https://up-as0.qiniup.com",
        _ => "https://up.qiniup.com",
    }
}

async fn upload_qiniu(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    object_key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let now = Utc::now().timestamp();
    let deadline = now + 3600;
    // scope = "{bucket}:{key}" for exact-key upload (prevents overwriting other keys)
    let scope = format!("{}:{}", bucket, object_key);

    let put_policy = serde_json::json!({
        "scope": scope,
        "deadline": deadline,
    });
    let put_policy_json = serde_json::to_string(&put_policy).map_err(|e| e.to_string())?;
    let encoded_policy = base64_url(put_policy_json.as_bytes());

    // Upload token = AK:sign(SK, encodedPolicy):encodedPolicy
    let sign = hmac_sha1(secret_key.as_bytes(), encoded_policy.as_bytes());
    let encoded_sign = base64_url(&sign);
    let token = format!("{}:{}:{}", access_key, encoded_sign, encoded_policy);

    let endpoint = qiniu_upload_endpoint(region);

    // Qiniu Form Upload API: POST multipart/form-data to the upload endpoint.
    // Fields: token (upload token), key (object key), file (binary content).
    // Reference: https://developer.qiniu.com/kodo/1312/upload
    let file_part = reqwest::multipart::Part::bytes(data)
        .file_name(object_key.to_string())
        .mime_str(content_type)
        .map_err(|e| format!("Invalid content-type: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("token", token)
        .text("key", object_key.to_string())
        .part("file", file_part);

    let client = reqwest::Client::new();
    let res = client
        .post(endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Qiniu upload failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Qiniu upload error ({}): {}", status, body));
    }

    // Return object key — frontend applies CDN domain on top
    Ok(object_key.to_string())
}

// ── Aliyun OSS ────────────────────────────────────────────────────────────────

async fn upload_aliyun_oss(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    endpoint: &str,
    object_key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let host = if endpoint.is_empty() {
        format!("{}.oss-{}.aliyuncs.com", bucket, region)
    } else {
        // Custom endpoint: use as-is (strip protocol, add bucket subdomain)
        let ep = endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        format!("{}.{}", bucket, ep)
    };
    let url = format!("https://{}/{}", host, object_key);

    // RFC 1123 date
    let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();

    // OSS v1 signature
    let string_to_sign = format!(
        "PUT\n\n{}\n{}\n/{}/{}",
        content_type, date, bucket, object_key
    );
    let sign = hmac_sha1(secret_key.as_bytes(), string_to_sign.as_bytes());
    let signature = base64_std(&sign);
    let authorization = format!("OSS {}:{}", access_key, signature);

    let client = reqwest::Client::new();
    let res = client
        .put(&url)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .header("Date", &date)
        .header("Host", &host)
        .body(data)
        .send()
        .await
        .map_err(|e| format!("Aliyun OSS upload failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Aliyun OSS upload error ({}): {}", status, body));
    }

    Ok(url)
}

// ── Tencent COS ───────────────────────────────────────────────────────────────

async fn upload_tencent_cos(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    object_key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let host = format!("{}.cos.{}.myqcloud.com", bucket, region);
    let url = format!("https://{}/{}", host, object_key);
    let path = format!("/{}", object_key);

    let now = Utc::now().timestamp();
    let start_time = now - 60;
    let end_time = now + 3600;
    let sign_time = format!("{};{}", start_time, end_time);

    // SignKey = HMAC-SHA1(secretKey, signTime)
    let sign_key = hmac_sha1(secret_key.as_bytes(), sign_time.as_bytes());
    let sign_key_hex = hex::encode(&sign_key);

    // HttpString
    let header_list = "content-type;host";
    let headers_str = format!("content-type:{}\nhost:{}\n", content_type, host);
    let http_string = format!("put\n{}\n\n{}\n{}", path, headers_str, header_list);

    // SHA1 of HttpString
    let http_string_hash = {
        use sha1::Sha1;
        let mut hasher = Sha1::new();
        hasher.update(http_string.as_bytes());
        hex::encode(hasher.finalize())
    };

    // StringToSign
    let string_to_sign = format!("sha1\n{}\n{}\n", sign_time, http_string_hash);

    // Signature = HMAC-SHA1(signKeyHex, stringToSign)
    let signature_bytes = hmac_sha1(sign_key_hex.as_bytes(), string_to_sign.as_bytes());
    let signature = hex::encode(&signature_bytes);

    let authorization = format!(
        "q-sign-algorithm=sha1&q-ak={}&q-sign-time={}&q-key-time={}&q-header-list={}&q-url-param-list=&q-signature={}",
        access_key, sign_time, sign_time, header_list, signature
    );

    let client = reqwest::Client::new();
    let res = client
        .put(&url)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .header("Host", &host)
        .body(data)
        .send()
        .await
        .map_err(|e| format!("Tencent COS upload failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Tencent COS upload error ({}): {}", status, body));
    }

    Ok(url)
}

// ── AWS S3 (SigV4) ────────────────────────────────────────────────────────────

fn aws_derive_signing_key(secret_key: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{}", secret_key).as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

async fn upload_aws_s3(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    region: &str,
    endpoint: &str,
    object_key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let now = Utc::now();
    let date_str = now.format("%Y%m%d").to_string();
    let datetime_str = now.format("%Y%m%dT%H%M%SZ").to_string();

    let host = if endpoint.is_empty() {
        format!("{}.s3.{}.amazonaws.com", bucket, region)
    } else {
        endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .to_string()
    };
    let url = format!("https://{}/{}", host, object_key);
    let path = format!("/{}", object_key);

    let payload_hash = sha256_hex(&data);

    // Canonical request
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        content_type, host, payload_hash, datetime_str
    );
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        path, canonical_headers, signed_headers, payload_hash
    );

    // String to sign
    let credential_scope = format!("{}/{}/s3/aws4_request", date_str, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        datetime_str,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    // Signing key and signature
    let signing_key = aws_derive_signing_key(secret_key, &date_str, region, "s3");
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{},SignedHeaders={},Signature={}",
        access_key, credential_scope, signed_headers, signature
    );

    let client = reqwest::Client::new();
    let res = client
        .put(&url)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &datetime_str)
        .body(data)
        .send()
        .await
        .map_err(|e| format!("AWS S3 upload failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("AWS S3 upload error ({}): {}", status, body));
    }

    Ok(url)
}

// ── Google Cloud Storage (HMAC V4) ────────────────────────────────────────────

async fn upload_google_gcs(
    access_key: &str,
    secret_key: &str,
    bucket: &str,
    object_key: &str,
    data: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    let now = Utc::now();
    let date_str = now.format("%Y%m%d").to_string();
    let datetime_str = now.format("%Y%m%dT%H%M%SZ").to_string();

    let host = "storage.googleapis.com";
    let url = format!("https://{}/{}/{}", host, bucket, object_key);
    let path = format!("/{}/{}", bucket, object_key);

    let payload_hash = sha256_hex(&data);

    // Canonical request (GCS HMAC V4 follows same structure as AWS SigV4)
    let signed_headers = "content-type;host;x-goog-content-sha256;x-goog-date";
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-goog-content-sha256:{}\nx-goog-date:{}\n",
        content_type, host, payload_hash, datetime_str
    );
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        path, canonical_headers, signed_headers, payload_hash
    );

    // String to sign (GCS uses GOOG4-HMAC-SHA256)
    let credential_scope = format!("{}/auto/storage/goog4_request", date_str);
    let string_to_sign = format!(
        "GOOG4-HMAC-SHA256\n{}\n{}\n{}",
        datetime_str,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    // Derive signing key (same 4-step HMAC as AWS but with "GOOG4" prefix)
    let k_date = hmac_sha256(format!("GOOG4{}", secret_key).as_bytes(), date_str.as_bytes());
    let k_region = hmac_sha256(&k_date, b"auto");
    let k_service = hmac_sha256(&k_region, b"storage");
    let signing_key = hmac_sha256(&k_service, b"goog4_request");
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "GOOG4-HMAC-SHA256 Credential={}/{},SignedHeaders={},Signature={}",
        access_key, credential_scope, signed_headers, signature
    );

    let client = reqwest::Client::new();
    let res = client
        .put(&url)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .header("Host", host)
        .header("x-goog-content-sha256", &payload_hash)
        .header("x-goog-date", &datetime_str)
        .body(data)
        .send()
        .await
        .map_err(|e| format!("GCS upload failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GCS upload error ({}): {}", status, body));
    }

    Ok(url)
}

// ── Tauri Command ─────────────────────────────────────────────────────────────

/// Upload a file to an object storage provider using HMAC request signing.
/// The signed HTTP request is made directly from Rust to keep secrets
/// out of frontend JavaScript.
///
/// Returns the public URL of the uploaded object, or the object key for
/// providers where the URL depends on a custom CDN domain (e.g. Qiniu).
#[command]
pub async fn upload_to_object_storage(
    provider: String,
    access_key: String,
    secret_key: String,
    bucket: String,
    region: String,
    endpoint: Option<String>,
    object_key: String,
    data: Vec<u8>,
    content_type: String,
) -> Result<String, String> {
    let endpoint = endpoint.unwrap_or_default();

    match provider.as_str() {
        "qiniu" => {
            upload_qiniu(
                &access_key,
                &secret_key,
                &bucket,
                &region,
                &object_key,
                data,
                &content_type,
            )
            .await
        }
        "aliyun-oss" => {
            upload_aliyun_oss(
                &access_key,
                &secret_key,
                &bucket,
                &region,
                &endpoint,
                &object_key,
                data,
                &content_type,
            )
            .await
        }
        "tencent-cos" => {
            upload_tencent_cos(
                &access_key,
                &secret_key,
                &bucket,
                &region,
                &object_key,
                data,
                &content_type,
            )
            .await
        }
        "aws-s3" => {
            upload_aws_s3(
                &access_key,
                &secret_key,
                &bucket,
                &region,
                &endpoint,
                &object_key,
                data,
                &content_type,
            )
            .await
        }
        "google-gcs" => {
            upload_google_gcs(
                &access_key,
                &secret_key,
                &bucket,
                &object_key,
                data,
                &content_type,
            )
            .await
        }
        _ => Err(format!("Unknown object storage provider: {}", provider)),
    }
}
