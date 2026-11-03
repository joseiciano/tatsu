use std::net::Ipv4Addr;

use if_addrs::{IfAddr, Interface};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanAddress {
    pub iface: String,
    pub address: String,
}

pub fn lan_addresses() -> Vec<LanAddress> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    group_lan_v4(
        interfaces
            .iter()
            .filter(|i| i.is_oper_up())
            .filter_map(external_v4),
    )
}

fn external_v4(interface: &Interface) -> Option<(&str, Ipv4Addr)> {
    match &interface.addr {
        IfAddr::V4(v4) if !v4.ip.is_loopback() => Some((interface.name.as_str(), v4.ip)),
        _ => None,
    }
}

// Node's networkInterfaces() is an object keyed by name, so entries group under the first time each name is seen.
fn group_lan_v4<'a>(entries: impl IntoIterator<Item = (&'a str, Ipv4Addr)>) -> Vec<LanAddress> {
    let mut groups: Vec<(&str, Vec<Ipv4Addr>)> = Vec::new();
    for (name, ip) in entries {
        match groups.iter_mut().find(|(n, _)| *n == name) {
            Some((_, ips)) => ips.push(ip),
            None => groups.push((name, vec![ip])),
        }
    }
    groups
        .into_iter()
        .flat_map(|(name, ips)| {
            ips.into_iter().map(move |ip| LanAddress {
                iface: name.to_owned(),
                address: ip.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn interleaved_entries_group_under_the_first_seen_name() {
        let grouped = group_lan_v4([
            ("en0", ip("192.168.1.5")),
            ("utun3", ip("10.8.0.2")),
            ("en0", ip("192.168.1.6")),
        ]);
        let pairs: Vec<(&str, &str)> = grouped
            .iter()
            .map(|a| (a.iface.as_str(), a.address.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("en0", "192.168.1.5"),
                ("en0", "192.168.1.6"),
                ("utun3", "10.8.0.2")
            ]
        );
    }

    #[test]
    fn host_enumeration_has_no_loopback_and_dotted_ipv4_only() {
        for entry in lan_addresses() {
            let parsed: Ipv4Addr = entry.address.parse().expect("dotted IPv4");
            assert!(!parsed.is_loopback(), "{entry:?}");
            assert!(!entry.iface.is_empty());
        }
    }
}
