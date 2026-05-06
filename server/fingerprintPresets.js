/**
 * Fingerprint presets for browser profiles.
 * Each preset defines a coherent set of browser fingerprint values.
 */

export const FINGERPRINT_PRESETS = {
  'chrome-win': {
    label: 'Chrome · Windows 11',
    icon: '🪟',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screen_resolution: '1920x1080',
    language: 'en-US,en',
    timezone: 'America/New_York',
    webgl_vendor: 'Google Inc. (NVIDIA)',
    webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,Calibri,Cambria,Cambria Math,Comic Sans MS,Consolas,Courier New,Georgia,Impact,Lucida Console,Lucida Sans Unicode,Microsoft Sans Serif,MS Gothic,MS PGothic,MS Sans Serif,MS Serif,Palatino Linotype,Segoe Print,Segoe Script,Segoe UI,Segoe UI Light,Segoe UI Semibold,Segoe UI Symbol,Tahoma,Times New Roman,Trebuchet MS,Verdana,Wingdings',
  },
  'chrome-mac': {
    label: 'Chrome · macOS',
    icon: '🍎',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screen_resolution: '1920x1080',
    language: 'en-US,en',
    timezone: 'America/New_York',
    webgl_vendor: 'Google Inc. (Apple)',
    webgl_renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,Arial Rounded MT Bold,Comic Sans MS,Courier New,Georgia,Helvetica,Helvetica Neue,Hiragino Sans,Impact,Lucida Grande,Lucida Sans Unicode,Palatino Linotype,Tahoma,Times New Roman,Trebuchet MS,Verdana',
  },
  'chrome-linux': {
    label: 'Chrome · Linux',
    icon: '🐧',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screen_resolution: '1920x1080',
    language: 'en-US,en',
    timezone: 'America/Los_Angeles',
    webgl_vendor: 'Google Inc. (Mesa)',
    webgl_renderer: 'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,DejaVu Sans,DejaVu Sans Mono,DejaVu Serif,Droid Sans,Droid Sans Mono,FreeMono,FreeSans,FreeSerif,Liberation Mono,Liberation Sans,Liberation Serif,Nimbus Mono L,Nimbus Roman No9 L,Nimbus Sans L,Tahoma,Times New Roman,Ubuntu,Ubuntu Mono,Verdana',
  },
  'firefox-win': {
    label: 'Firefox · Windows 11',
    icon: '🦊',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    screen_resolution: '1920x1080',
    language: 'en-US,en',
    timezone: 'America/New_York',
    webgl_vendor: 'Google Inc. (NVIDIA)',
    webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,Calibri,Cambria,Comic Sans MS,Consolas,Courier New,Georgia,Impact,Lucida Console,Palatino Linotype,Segoe UI,Tahoma,Times New Roman,Trebuchet MS,Verdana',
  },
  'chrome-vn': {
    label: 'Chrome · Vietnam',
    icon: '🇻🇳',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screen_resolution: '1366x768',
    language: 'vi-VN,vi,en-US,en',
    timezone: 'Asia/Ho_Chi_Minh',
    webgl_vendor: 'Google Inc. (Intel)',
    webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,Calibri,Cambria,Comic Sans MS,Consolas,Courier New,Georgia,Impact,Lucida Console,Palatino Linotype,Segoe UI,Tahoma,Times New Roman,Trebuchet MS,Verdana',
  },
  'chrome-jp': {
    label: 'Chrome · Japan',
    icon: '🇯🇵',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    screen_resolution: '1920x1080',
    language: 'ja-JP,ja,en-US,en',
    timezone: 'Asia/Tokyo',
    webgl_vendor: 'Google Inc. (NVIDIA)',
    webgl_renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvas_noise: 1,
    font_masking: 'Arial,Arial Black,Calibri,Cambria,Comic Sans MS,Consolas,Courier New,Georgia,Impact,MS Gothic,MS PGothic,MS UI Gothic,Meiryo,Meiryo UI,Yu Gothic,Yu Gothic UI,Tahoma,Times New Roman,Verdana',
  },
};

export const TIMEZONE_OPTIONS = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
];

export const LANGUAGE_OPTIONS = [
  { value: 'en-US,en', label: 'English (US)' },
  { value: 'en-GB,en', label: 'English (UK)' },
  { value: 'vi-VN,vi,en-US,en', label: 'Tiếng Việt' },
  { value: 'ja-JP,ja,en-US,en', label: '日本語' },
  { value: 'ko-KR,ko,en-US,en', label: '한국어' },
  { value: 'zh-CN,zh,en-US,en', label: '简体中文' },
  { value: 'zh-TW,zh,en-US,en', label: '繁體中文' },
  { value: 'fr-FR,fr,en-US,en', label: 'Français' },
  { value: 'de-DE,de,en-US,en', label: 'Deutsch' },
  { value: 'es-ES,es,en-US,en', label: 'Español' },
  { value: 'pt-BR,pt,en-US,en', label: 'Português (BR)' },
  { value: 'th-TH,th,en-US,en', label: 'ไทย' },
];

export const RESOLUTION_OPTIONS = [
  '1920x1080', '1366x768', '1440x900', '1536x864',
  '2560x1440', '1280x720', '1600x900', '3840x2160',
];
