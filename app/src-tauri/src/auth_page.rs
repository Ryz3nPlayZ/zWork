//! The one-shot HTML served on the localhost OAuth callback socket after the
//! browser hands us the auth code. It renders in the user's default browser,
//! not the app webview, and the callback listener answers a single request,
//! so the brand fonts and logo are embedded as data URLs — there is no
//! opportunity for the page to fetch assets.

use base64::{engine::general_purpose::STANDARD, Engine};

const REGULAR_WOFF2: &[u8] = include_bytes!("../../public/fonts/instrument-serif-regular.woff2");
const ITALIC_WOFF2: &[u8] = include_bytes!("../../public/fonts/instrument-serif-italic.woff2");

const PAGE_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__HEADING__</title>
<style>
@font-face{font-family:'Instrument Serif';src:url(data:font/woff2;base64,__REGULAR__) format('woff2');font-weight:400;font-style:normal;font-display:block}
@font-face{font-family:'Instrument Serif';src:url(data:font/woff2;base64,__ITALIC__) format('woff2');font-weight:400;font-style:italic;font-display:block}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f0e8;color:#302e28;font-family:'Instrument Serif',Georgia,'Times New Roman',serif;-webkit-font-smoothing:antialiased}
.card{padding:42px 52px 38px;text-align:center;border:1px solid rgba(21,19,19,.1);border-radius:20px;background:rgba(255,255,255,.72);animation:rise .3s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.mark{width:36px;height:36px;margin:0 auto 20px;display:block}
h1{margin:0 0 12px;font-size:30px;font-weight:400;font-style:italic;letter-spacing:.01em}
p{margin:0 auto;font-size:17px;line-height:1.55;color:#6e6a60;max-width:32ch}
@media (prefers-color-scheme:dark){
body{background:#161618;color:#eceaea}
.card{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
p{color:#a0a09d}
}
</style>
</head>
<body>
<div class="card">
<svg class="mark" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M 21.287 2 L 22.287 2 C 23.171 2 23.654 2.716 23.367 3.6 L 20.833 11.4 C 20.546 12.284 19.597 13 18.713 13 L 17.713 13 C 16.829 13 16.346 12.284 16.633 11.4 L 19.167 3.6 C 19.454 2.716 20.403 2 21.287 2 Z M 36.232 12.115 L 36.732 12.981 C 37.174 13.746 36.795 14.523 35.886 14.716 L 27.864 16.421 C 26.955 16.614 25.86 16.151 25.419 15.385 L 24.919 14.519 C 24.477 13.754 24.855 12.977 25.764 12.784 L 33.786 11.079 C 34.695 10.886 35.79 11.349 36.232 12.115 Z M 34.945 30.115 L 34.445 30.981 C 34.003 31.746 33.141 31.807 32.519 31.116 L 27.031 25.021 C 26.41 24.331 26.264 23.151 26.706 22.385 L 27.206 21.519 C 27.648 20.754 28.51 20.693 29.131 21.384 L 34.619 27.479 C 35.241 28.169 35.387 29.349 34.945 30.115 Z M 18.713 38 L 17.713 38 C 16.829 38 16.346 37.284 16.633 36.4 L 19.167 28.6 C 19.454 27.716 20.403 27 21.287 27 L 22.287 27 C 23.171 27 23.654 27.716 23.367 28.6 L 20.833 36.4 C 20.546 37.284 19.597 38 18.713 38 Z M 3.768 27.885 L 3.268 27.019 C 2.826 26.254 3.205 25.477 4.114 25.284 L 12.136 23.579 C 13.045 23.386 14.14 23.849 14.581 24.615 L 15.081 25.481 C 15.523 26.246 15.145 27.023 14.236 27.216 L 6.214 28.921 C 5.305 29.114 4.21 28.651 3.768 27.885 Z M 5.055 9.885 L 5.555 9.019 C 5.997 8.254 6.859 8.193 7.481 8.884 L 12.969 14.979 C 13.59 15.669 13.736 16.849 13.294 17.615 L 12.794 18.481 C 12.352 19.246 11.49 19.307 10.869 18.616 L 5.381 12.521 C 4.759 11.831 4.613 10.651 5.055 9.885 Z"/></svg>
<h1>__HEADING__</h1>
<p>__BODY__</p>
</div>
</body>
</html>"#;

/// The branded page shown in the browser once the localhost OAuth callback
/// fires. `success` picks between the signed-in and sign-in-failed variants.
pub fn callback_page(success: bool) -> String {
    let (heading, body) = if success {
        (
            "Signed in to zWork",
            "That\u{2019}s everything \u{2014} close this tab and get back to work.",
        )
    } else {
        (
            "Sign-in failed",
            "Something went wrong finishing sign-in. Head back to zWork and try again.",
        )
    };
    PAGE_TEMPLATE
        .replace("__REGULAR__", &STANDARD.encode(REGULAR_WOFF2))
        .replace("__ITALIC__", &STANDARD.encode(ITALIC_WOFF2))
        .replace("__HEADING__", heading)
        .replace("__BODY__", body)
}
