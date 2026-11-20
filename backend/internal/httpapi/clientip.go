package httpapi

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// sourceIP is the address a request came from, as recorded in Audit Events.
//
// Behind the per-host Nginx (ADR 0003) the connection comes from the proxy.
// When the connection's peer is one of trustedProxies, the last
// X-Forwarded-For entry is used: the one that proxy appended. Earlier entries
// are whatever the client chose to send, and from any other peer the header
// is ignored entirely, so a client reaching the service directly cannot
// choose its recorded address.
func sourceIP(r *http.Request, trustedProxies []netip.Prefix) netip.Addr {
	peer := peerAddr(r)
	if !peer.IsValid() || !contains(trustedProxies, peer) {
		return peer
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return peer
	}
	entries := strings.Split(values[len(values)-1], ",")
	addr, err := netip.ParseAddr(strings.TrimSpace(entries[len(entries)-1]))
	if err != nil {
		return peer
	}
	return addr.Unmap()
}

func peerAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return addr.Unmap()
}

func contains(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
