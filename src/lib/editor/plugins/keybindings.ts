/**
 * Typora-style keyboard shortcuts for Moraya
 * Reference: https://support.typora.io/Shortcut-Keys/
 */

export interface KeyBinding {
  key: string;
  mod: boolean;    // Cmd (macOS) or Ctrl (Win/Linux)
  shift?: boolean;
  alt?: boolean;
  action: string;
  description: string;
}

// File operations
export const fileShortcuts: KeyBinding[] = [
  { key: 'n', mod: true, action: 'new-file', description: 'New' },
  { key: 'n', mod: true, shift: true, action: 'new-window', description: 'New Window' },
  { key: 'o', mod: true, action: 'open-file', description: 'Open' },
  { key: 's', mod: true, action: 'save', description: 'Save' },
  { key: 's', mod: true, shift: true, action: 'save-as', description: 'Save As' },
];

// Edit operations (handled by Milkdown/ProseMirror)
export const editShortcuts: KeyBinding[] = [
  { key: 'z', mod: true, action: 'undo', description: 'Undo' },
  { key: 'z', mod: true, shift: true, action: 'redo', description: 'Redo' },
  { key: 'x', mod: true, action: 'cut', description: 'Cut' },
  { key: 'c', mod: true, action: 'copy', description: 'Copy' },
  { key: 'v', mod: true, action: 'paste', description: 'Paste' },
  { key: 'a', mod: true, action: 'select-all', description: 'Select All' },
];

// Paragraph/block formatting (Typora-style)
export const paragraphShortcuts: KeyBinding[] = [
  { key: '1', mod: true, action: 'heading-1', description: 'Heading 1' },
  { key: '2', mod: true, action: 'heading-2', description: 'Heading 2' },
  { key: '3', mod: true, action: 'heading-3', description: 'Heading 3' },
  { key: '4', mod: true, action: 'heading-4', description: 'Heading 4' },
  { key: '5', mod: true, action: 'heading-5', description: 'Heading 5' },
  { key: '6', mod: true, action: 'heading-6', description: 'Heading 6' },
  { key: '0', mod: true, action: 'paragraph', description: 'Paragraph' },
  { key: '=', mod: true, shift: true, action: 'increase-heading', description: 'Increase Heading Level' },
  { key: '-', mod: true, shift: true, action: 'decrease-heading', description: 'Decrease Heading Level' },
  { key: ']', mod: true, action: 'indent', description: 'Increase Indent' },
  { key: '[', mod: true, action: 'outdent', description: 'Decrease Indent' },
  { key: 't', mod: true, shift: true, action: 'table', description: 'Insert Table' },
  { key: 'k', mod: true, shift: true, action: 'code-block', description: 'Code Block' },
  { key: 'm', mod: true, shift: true, action: 'math-block', description: 'Math Block' },
  { key: 'q', mod: true, shift: true, action: 'blockquote', description: 'Quote' },
  { key: 'l', mod: true, shift: true, action: 'ordered-list', description: 'Ordered List' },
  { key: 'u', mod: true, shift: true, action: 'bullet-list', description: 'Unordered List' },
  { key: 'x', mod: true, shift: true, action: 'task-list', description: 'Task List' },
];

// Inline formatting (Typora-style)
export const formatShortcuts: KeyBinding[] = [
  { key: 'b', mod: true, action: 'bold', description: 'Bold' },
  { key: 'i', mod: true, action: 'italic', description: 'Italic' },
  { key: 'u', mod: true, action: 'underline', description: 'Underline' },
  { key: '`', mod: true, action: 'code', description: 'Code' },
  { key: 'k', mod: true, action: 'link', description: 'Hyperlink' },
  { key: 'd', mod: true, shift: true, action: 'strikethrough', description: 'Strikethrough' },
  { key: 'i', mod: true, shift: true, action: 'image', description: 'Insert Image' },
];

// View shortcuts
export const viewShortcuts: KeyBinding[] = [
  { key: '\\', mod: true, action: 'toggle-sidebar', description: 'Toggle Sidebar' },
  { key: '/', mod: true, action: 'toggle-source', description: 'Toggle Source Mode' },
  { key: '+', mod: true, action: 'zoom-in', description: 'Zoom In' },
  { key: '-', mod: true, action: 'zoom-out', description: 'Zoom Out' },
  { key: '0', mod: true, shift: true, action: 'zoom-reset', description: 'Reset Zoom' },
  { key: 'F11', mod: false, action: 'fullscreen', description: 'Toggle Fullscreen' },
  { key: 'p', mod: true, action: 'quick-open', description: 'Quick Open' },
];

export const allShortcuts: KeyBinding[] = [
  ...fileShortcuts,
  ...paragraphShortcuts,
  ...formatShortcuts,
  ...viewShortcuts,
];
