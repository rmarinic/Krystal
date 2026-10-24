//! Who this host is to a phone: the machine's name and LAN address, and the
//! pairing PIN and bearer tokens it hands out.


/* ------------------------------ tiny secrets ----------------------------- */
/* No `rand` in the tree; `uuid` v4 is already here and is CSPRNG-backed
 * (getrandom), so both secrets are cut from fresh v4 bytes. */

/// What to call this machine in a connected client's UI. Best effort: the
/// computer name if the OS offers one, otherwise the LAN address.
pub(super) fn machine_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    lan_ip().unwrap_or_else(|| "Krystal".to_string())
}

pub(super) fn new_pin() -> String {
    let b = *uuid::Uuid::new_v4().as_bytes();
    let n = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    format!("{n:06}")
}

pub(super) fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Length-and-content compare that does not bail on the first differing byte, so
/// a wrong PIN leaks no timing signal about how much of it was right.
pub(super) fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/* -------------------------------- LAN IP --------------------------------- */

/// This machine's address on the local network — what a client has to type.
///
/// Found by opening a UDP socket "to" a routable address and asking the OS which
/// local interface it picked. No packet is ever sent (a UDP connect only fixes
/// the route) and it needs no extra dependency — but it does need a default
/// route, so a machine with no gateway reports nothing and the UI says so.
pub fn lan_ip() -> Option<String> {
    for probe in ["8.8.8.8:80", "192.168.1.1:80", "10.0.0.1:80"] {
        let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if sock.connect(probe).is_err() {
            continue;
        }
        let Ok(addr) = sock.local_addr() else { continue };
        let ip = addr.ip();
        if !ip.is_loopback() && !ip.is_unspecified() {
            return Some(ip.to_string());
        }
    }
    None
}

/// Did this connection come from another device? One made *on* this machine —
/// to `localhost`, or to its own LAN address — arrives with a peer address that
/// is loopback or the very address it was received on. Those prove nothing about
/// the network, so they must not count as "a device reached us".
pub(super) fn from_elsewhere(peer: std::net::IpAddr, local: std::net::IpAddr) -> bool {
    !peer.is_loopback() && peer != local
}
