import ipaddr from 'ipaddr.js';

export function canonicalizeIp(ip: string): string {
	try {
		const parsed = ipaddr.parse(ip);

		if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
			return (parsed as ipaddr.IPv6).toIPv4Address().toString();
		}

		return ip;
	} catch {
		return ip;
	}
}
