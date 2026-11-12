//! xiaonux-net: lets the xiaonux browser VM use this computer's internet.
//!
//! Serves on 127.0.0.1 only:
//!   GET /wisp?token=T   WebSocket, WISP v1 (TCP streams)
//!   GET /ping?token=T&host=H   {"rtt_ms": N} (TCP connect time to H:443, then :80)
//!
//! Safety: only the configured page origins may connect, every request needs
//! the pairing token printed at startup, and destinations that resolve to
//! loopback / private / link-local / multicast addresses are refused unless
//! --allow-lan is given (so a web page can't use this to reach your network).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::protocol::{Message, Role};
use tokio_tungstenite::WebSocketStream;

const CONNECT: u8 = 1;
const DATA: u8 = 2;
const CONTINUE: u8 = 3;
const CLOSE: u8 = 4;
/// DATA packets a client may send per stream before waiting for CONTINUE.
const BUFFER: u32 = 128;

const CLOSE_VOLUNTARY: u8 = 0x02;
const CLOSE_NETWORK_ERROR: u8 = 0x03;
const CLOSE_INVALID: u8 = 0x41;
const CLOSE_UNREACHABLE: u8 = 0x42;
const CLOSE_TIMEOUT: u8 = 0x43;
const CLOSE_REFUSED: u8 = 0x44;
const CLOSE_BLOCKED: u8 = 0x48;

struct Config {
    port: u16,
    token: String,
    origins: Vec<String>,
    allow_lan: bool,
    ports: Option<Vec<u16>>, // None = any port
    verbose: bool,
}

fn usage() -> ! {
    eprintln!(
        "xiaonux-net {}\n\
         Lets the xiaonux browser VM use this computer's internet.\n\n\
         Options:\n\
         \x20 --port N          listen on 127.0.0.1:N (default 8787)\n\
         \x20 --origin URL      page origin allowed to connect (repeatable;\n\
         \x20                   default http://localhost:5180)\n\
         \x20 --token T         pairing token (default: random, printed)\n\
         \x20 --any-port        allow any destination port (default 80, 443)\n\
         \x20 --allow-lan       allow loopback / private / LAN destinations\n\
         \x20 -v                log each connection (host and bytes only)",
        env!("CARGO_PKG_VERSION")
    );
    std::process::exit(2);
}

fn parse_args() -> Config {
    let mut c = Config {
        port: 8787,
        token: String::new(),
        origins: vec![],
        allow_lan: false,
        ports: Some(vec![80, 443]),
        verbose: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => c.port = args.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| usage()),
            "--origin" => c.origins.push(args.next().unwrap_or_else(|| usage()).trim_end_matches('/').to_string()),
            "--token" => c.token = args.next().unwrap_or_else(|| usage()),
            "--any-port" => c.ports = None,
            "--allow-lan" => c.allow_lan = true,
            "-v" | "--verbose" => c.verbose = true,
            _ => usage(),
        }
    }
    if c.origins.is_empty() {
        c.origins.push("http://localhost:5180".into());
    }
    if c.token.is_empty() {
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).expect("random");
        c.token = b.iter().map(|x| format!("{x:02x}")).collect();
    }
    c
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cfg = Arc::new(parse_args());
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!("xiaonux-net listening on {addr}");
    for o in &cfg.origins {
        println!("Open {o}/?net=helper&port={}&token={}", cfg.port, cfg.token);
    }
    loop {
        let Ok((sock, _)) = listener.accept().await else { continue };
        let cfg = cfg.clone();
        tokio::spawn(async move {
            let _ = handle(sock, cfg).await;
        });
    }
}

struct Request {
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

async fn read_request(sock: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        if buf.len() > 16 * 1024 {
            return None;
        }
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    if first.next()? != "GET" {
        return None;
    }
    let target = first.next()?;
    let (path, qs) = target.split_once('?').unwrap_or((target, ""));
    let query = qs
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), percent_decode(v)))
        .collect();
    let headers = lines
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some(Request { path: path.to_string(), query, headers })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn respond(sock: &mut TcpStream, status: &str, origin: Option<&str>, body: &str) {
    let cors = origin
        .map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n"))
        .unwrap_or_default();
    let r = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
         {cors}Access-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(r.as_bytes()).await;
}

async fn handle(mut sock: TcpStream, cfg: Arc<Config>) -> Option<()> {
    let req = read_request(&mut sock).await?;
    let origin = req.headers.get("origin").cloned();
    let origin_ok = origin.as_deref().map_or(false, |o| cfg.origins.iter().any(|a| a == o));
    if !origin_ok {
        respond(&mut sock, "403 Forbidden", None, r#"{"error":"origin not allowed"}"#).await;
        return None;
    }
    if req.query.get("token").map(String::as_str) != Some(cfg.token.as_str()) {
        respond(&mut sock, "403 Forbidden", origin.as_deref(), r#"{"error":"bad token"}"#).await;
        return None;
    }
    match req.path.as_str() {
        "/ping" => {
            let host = req.query.get("host").cloned().unwrap_or_default();
            match ping(&host, &cfg).await {
                Some(ms) => respond(&mut sock, "200 OK", origin.as_deref(), &format!(r#"{{"rtt_ms":{ms:.1}}}"#)).await,
                None => respond(&mut sock, "403 Forbidden", origin.as_deref(), r#"{"error":"unreachable or not allowed"}"#).await,
            }
            None
        }
        "/wisp" => {
            let key = req.headers.get("sec-websocket-key")?;
            let mut h = Sha1::new();
            h.update(key.as_bytes());
            h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
            let accept = base64::engine::general_purpose::STANDARD.encode(h.finalize());
            let r = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                 Sec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            sock.write_all(r.as_bytes()).await.ok()?;
            let _ = sock.set_nodelay(true);
            let ws = WebSocketStream::from_raw_socket(sock, Role::Server, None).await;
            wisp_session(ws, cfg).await;
            None
        }
        _ => {
            respond(&mut sock, "404 Not Found", origin.as_deref(), r#"{"error":"not found"}"#).await;
            None
        }
    }
}

/// Is this address somewhere a web page must not reach by default?
fn is_local(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            a.is_loopback() || a.is_private() || a.is_link_local() || a.is_multicast()
                || a.is_broadcast() || a.is_unspecified()
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64/10 CGNAT
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18/15 benchmarking
                || o[0] == 0 || o[0] >= 240
        }
        IpAddr::V6(a) => {
            let s = a.segments();
            a.is_loopback() || a.is_unspecified() || a.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || a.to_ipv4_mapped().map_or(false, |v4| is_local(&IpAddr::V4(v4)))
        }
    }
}

/// Resolve and check a destination. Returns addresses we may connect to.
async fn resolve(host: &str, port: u16, cfg: &Config) -> Result<Vec<SocketAddr>, u8> {
    if host.is_empty() || host.len() > 253 {
        return Err(CLOSE_INVALID);
    }
    if let Some(ports) = &cfg.ports {
        if !ports.contains(&port) {
            return Err(CLOSE_BLOCKED);
        }
    }
    let addrs: Vec<SocketAddr> = match tokio::net::lookup_host((host, port)).await {
        Ok(a) => a.collect(),
        Err(_) => return Err(CLOSE_UNREACHABLE),
    };
    let allowed: Vec<SocketAddr> = addrs.into_iter().filter(|a| cfg.allow_lan || !is_local(&a.ip())).collect();
    if allowed.is_empty() {
        return Err(CLOSE_BLOCKED);
    }
    Ok(allowed)
}

async fn connect(host: &str, port: u16, cfg: &Config) -> Result<TcpStream, u8> {
    let addrs = resolve(host, port, cfg).await?;
    let mut last = CLOSE_UNREACHABLE;
    for a in addrs {
        match tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => last = CLOSE_REFUSED,
            Ok(Err(_)) => last = CLOSE_UNREACHABLE,
            Err(_) => last = CLOSE_TIMEOUT,
        }
    }
    Err(last)
}

/// Round trip by TCP connect time (works without privileges on every OS).
async fn ping(host: &str, cfg: &Config) -> Option<f64> {
    for port in [443u16, 80] {
        let Ok(addrs) = resolve(host, port, &Config { ports: None, ..clone_cfg(cfg) }).await else { return None };
        let t = Instant::now();
        if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(addrs[0])).await {
            return Some(t.elapsed().as_secs_f64() * 1000.0);
        }
    }
    None
}

fn clone_cfg(c: &Config) -> Config {
    Config {
        port: c.port,
        token: c.token.clone(),
        origins: c.origins.clone(),
        allow_lan: c.allow_lan,
        ports: c.ports.clone(),
        verbose: c.verbose,
    }
}

fn packet(kind: u8, id: u32, payload: &[u8]) -> Message {
    let mut b = Vec::with_capacity(5 + payload.len());
    b.push(kind);
    b.extend_from_slice(&id.to_le_bytes());
    b.extend_from_slice(payload);
    Message::Binary(b)
}

struct StreamState {
    to_tcp: mpsc::UnboundedSender<Vec<u8>>,
    in_flight: Arc<AtomicU32>,
}

async fn wisp_session(ws: WebSocketStream<TcpStream>, cfg: Arc<Config>) {
    let (mut sink, mut source) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    // writer: everything to the browser goes through one channel
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });
    let _ = out_tx.send(packet(CONTINUE, 0, &BUFFER.to_le_bytes()));
    let streams: Arc<Mutex<HashMap<u32, StreamState>>> = Arc::new(Mutex::new(HashMap::new()));

    while let Some(Ok(msg)) = source.next().await {
        let Message::Binary(p) = msg else { continue };
        if p.len() < 5 {
            continue;
        }
        let id = u32::from_le_bytes([p[1], p[2], p[3], p[4]]);
        let body = &p[5..];
        match p[0] {
            CONNECT if body.len() >= 3 && body[0] == 1 => {
                let port = u16::from_le_bytes([body[1], body[2]]);
                let host = String::from_utf8_lossy(&body[3..]).into_owned();
                let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
                let in_flight = Arc::new(AtomicU32::new(0));
                streams.lock().await.insert(id, StreamState { to_tcp: tx, in_flight: in_flight.clone() });
                tokio::spawn(run_stream(id, host, port, rx, in_flight, out_tx.clone(), streams.clone(), cfg.clone()));
            }
            CONNECT => {
                let _ = out_tx.send(packet(CLOSE, id, &[CLOSE_INVALID]));
            }
            DATA => {
                if let Some(s) = streams.lock().await.get(&id) {
                    s.in_flight.fetch_add(1, Ordering::Relaxed);
                    let _ = s.to_tcp.send(body.to_vec());
                }
            }
            CLOSE => {
                // dropping the sender ends the stream's TCP writer
                streams.lock().await.remove(&id);
            }
            _ => {}
        }
    }
    streams.lock().await.clear();
    drop(out_tx);
    let _ = writer.await;
}

#[allow(clippy::too_many_arguments)]
async fn run_stream(
    id: u32,
    host: String,
    port: u16,
    mut from_ws: mpsc::UnboundedReceiver<Vec<u8>>,
    in_flight: Arc<AtomicU32>,
    out: mpsc::UnboundedSender<Message>,
    streams: Arc<Mutex<HashMap<u32, StreamState>>>,
    cfg: Arc<Config>,
) {
    let tcp = match connect(&host, port, &cfg).await {
        Ok(s) => s,
        Err(reason) => {
            if cfg.verbose {
                eprintln!("refused {host}:{port} (0x{reason:02x})");
            }
            streams.lock().await.remove(&id);
            let _ = out.send(packet(CLOSE, id, &[reason]));
            return;
        }
    };
    let (mut rd, mut wr) = tcp.into_split();
    let up = Arc::new(AtomicU32::new(0));
    let down = Arc::new(AtomicU32::new(0));

    // browser -> remote, refilling the client's buffer as we drain it
    let out2 = out.clone();
    let up2 = up.clone();
    let to_remote = tokio::spawn(async move {
        let mut since_continue = 0u32;
        while let Some(d) = from_ws.recv().await {
            if wr.write_all(&d).await.is_err() {
                break;
            }
            up2.fetch_add(d.len() as u32, Ordering::Relaxed);
            let left = in_flight.fetch_sub(1, Ordering::Relaxed) - 1;
            since_continue += 1;
            if since_continue >= BUFFER / 2 {
                since_continue = 0;
                let _ = out2.send(packet(CONTINUE, id, &(BUFFER - left).to_le_bytes()));
            }
        }
        let _ = wr.shutdown().await;
    });

    // remote -> browser
    let mut buf = vec![0u8; 16 * 1024];
    let reason = loop {
        match rd.read(&mut buf).await {
            Ok(0) => break CLOSE_VOLUNTARY,
            Ok(n) => {
                down.fetch_add(n as u32, Ordering::Relaxed);
                if out.send(packet(DATA, id, &buf[..n])).is_err() {
                    break CLOSE_NETWORK_ERROR;
                }
            }
            Err(_) => break CLOSE_NETWORK_ERROR,
        }
    };
    let still_open = streams.lock().await.remove(&id).is_some();
    if still_open {
        let _ = out.send(packet(CLOSE, id, &[reason]));
    }
    to_remote.abort();
    if cfg.verbose {
        eprintln!("{host}:{port} up {} B down {} B", up.load(Ordering::Relaxed), down.load(Ordering::Relaxed));
    }
}
