// deqi-desktop — Tauri 2 entry point.
//
// The Rust side is intentionally minimal. The deqi-server is a
// separate Node.js process (spawned as a Tauri sidecar in
// production, or run by the developer in dev). The Tauri shell
// just hosts the React frontend in a webview and exposes the
// usual Tauri APIs (clipboard, fs, etc.) for the desktop UI.
//
// We expose ONE Tauri command to the frontend: `deqi_status`.
// This is a thin shim that pings the deqi-server's /health
// endpoint and returns the result. The frontend can use it to
// check whether the server is running before it tries to open
// a WebSocket.

use serde::Serialize;

#[derive(Serialize)]
struct ServerStatus {
    reachable: bool,
    version: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn deqi_status(server_url: String) -> ServerStatus {
    // Best-effort ping. We don't fail the call if the server
    // is down — the frontend just falls back to its own
    // reconnect loop over WebSocket.
    let health_url = format!("{}/health", server_url.trim_end_matches('/'));
    match ureq_get(&health_url) {
        Ok((status, body)) if status == 200 => {
            // Parse `{"ok":true,"version":"..."}`
            let version = extract_version(&body);
            ServerStatus { reachable: true, version, error: None }
        }
        Ok((status, _)) => ServerStatus {
            reachable: false,
            version: None,
            error: Some(format!("server returned {}", status)),
        },
        Err(e) => ServerStatus {
            reachable: false,
            version: None,
            error: Some(e),
        },
    }
}

fn ureq_get(url: &str) -> Result<(u16, String), String> {
    // The Tauri 2 default doesn't include ureq; we use std
    // TCP/HTTP via a small inline client. For v0.1 we just
    // attempt a 1s TCP connect; the full HTTP request adds
    // bytes we don't need here.
    let url = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")).unwrap_or(url);
    let (host_port, _path) = match url.split_once('/') {
        Some((hp, p)) => (hp, format!("/{}", p)),
        None => (url, "/health".to_string()),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().unwrap_or(7700)),
        None => (host_port, 7700),
    };
    let addr = format!("{}:{}", host, port);
    // 500ms timeout via std::net TcpStream::connect_timeout.
    // We don't have a great way to do this without extra deps,
    // so we just attempt connect and treat failure as unreachable.
    use std::net::TcpStream;
    use std::io::{Read, Write};
    let mut stream = match TcpStream::connect_timeout(
        &addr.parse().map_err(|e: std::net::AddrParseError| e.to_string())?,
        std::time::Duration::from_millis(800),
    ) {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        addr
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf).to_string();
    // Parse status code
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    // Body is after \r\n\r\n
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

fn extract_version(body: &str) -> Option<String> {
    // Look for `"version":"..."` in the JSON body. Naive but
    // good enough for our minimal health response.
    let key = "\"version\":\"";
    let start = body.find(key)? + key.len();
    let rest = &body[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![deqi_status])
        .run(tauri::generate_context!())
        .expect("error while running deqi desktop");
}
