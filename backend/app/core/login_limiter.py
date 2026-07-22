import ipaddress
import math
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Optional, Sequence, Tuple, Union


IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]
IPNetwork = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]


@dataclass
class _AttemptState:
    failures: Deque[float] = field(default_factory=deque)
    locked_until: float = 0.0


@dataclass(frozen=True)
class LoginFailureResult:
    retry_after: Optional[int]
    newly_locked: bool = False


class LoginAttemptLimiter:
    """Bounded, process-local login limiter for the current single-instance API.

    State is intentionally kept in memory. Deployments with multiple workers or
    replicas must replace this with a shared atomic store such as Redis.
    """

    def __init__(
        self,
        *,
        max_failures: int,
        window_seconds: int,
        lockout_seconds: int,
        max_clients: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_failures < 1:
            raise ValueError("max_failures must be at least 1")
        if window_seconds < 1:
            raise ValueError("window_seconds must be at least 1")
        if lockout_seconds < 1:
            raise ValueError("lockout_seconds must be at least 1")
        if max_clients < 1:
            raise ValueError("max_clients must be at least 1")

        self._max_failures = max_failures
        self._window_seconds = window_seconds
        self._lockout_seconds = lockout_seconds
        self._max_clients = max_clients
        self._clock = clock
        self._states: "OrderedDict[str, _AttemptState]" = OrderedDict()
        self._lock = threading.RLock()
        self._cleanup_interval = max(
            1.0,
            min(float(window_seconds), float(lockout_seconds), 60.0),
        )
        self._last_cleanup = clock()

    def retry_after(self, client_id: str) -> Optional[int]:
        """Return remaining lockout seconds, or ``None`` when a try is allowed."""
        now = self._clock()
        with self._lock:
            self._cleanup(now)
            state = self._states.get(client_id)
            if state is None:
                return None

            retry_after = self._retry_after(state, now)
            if retry_after is None and not state.failures:
                self._states.pop(client_id, None)
            else:
                self._states.move_to_end(client_id)
            return retry_after

    def record_failure(self, client_id: str) -> LoginFailureResult:
        """Record a failure and report whether this call entered lockout."""
        now = self._clock()
        with self._lock:
            self._cleanup(now)
            state = self._states.get(client_id)
            if state is None:
                state = _AttemptState()
                self._states[client_id] = state
            else:
                retry_after = self._retry_after(state, now)
                if retry_after is not None:
                    self._states.move_to_end(client_id)
                    return LoginFailureResult(retry_after=retry_after)

            self._prune_failures(state, now)
            state.failures.append(now)
            newly_locked = False
            if len(state.failures) >= self._max_failures:
                state.failures.clear()
                state.locked_until = now + self._lockout_seconds
                newly_locked = True

            self._states.move_to_end(client_id)
            self._enforce_capacity()
            return LoginFailureResult(
                retry_after=self._retry_after(state, now),
                newly_locked=newly_locked,
            )

    def clear(self, client_id: str) -> None:
        """Clear failures after a successful login."""
        with self._lock:
            self._states.pop(client_id, None)

    @property
    def tracked_client_count(self) -> int:
        with self._lock:
            return len(self._states)

    def _retry_after(self, state: _AttemptState, now: float) -> Optional[int]:
        if state.locked_until > now:
            # Floating-point cancellation can make an exact 30-second lockout
            # appear as 30.0000000005 and incorrectly emit Retry-After: 31.
            return min(
                self._lockout_seconds,
                max(1, math.ceil(state.locked_until - now)),
            )
        if state.locked_until:
            state.locked_until = 0.0
            state.failures.clear()
        self._prune_failures(state, now)
        return None

    def _prune_failures(self, state: _AttemptState, now: float) -> None:
        cutoff = now - self._window_seconds
        while state.failures and state.failures[0] <= cutoff:
            state.failures.popleft()

    def _cleanup(self, now: float) -> None:
        if now - self._last_cleanup < self._cleanup_interval:
            return
        for client_id, state in list(self._states.items()):
            self._retry_after(state, now)
            if not state.failures and not state.locked_until:
                self._states.pop(client_id, None)
        self._last_cleanup = now

    def _enforce_capacity(self) -> None:
        while len(self._states) > self._max_clients:
            self._states.popitem(last=False)


def parse_trusted_proxy_cidrs(value: str) -> Tuple[IPNetwork, ...]:
    networks = []
    for raw_cidr in value.split(","):
        cidr = raw_cidr.strip()
        if cidr:
            networks.append(ipaddress.ip_network(cidr, strict=False))
    return tuple(networks)


def resolve_client_ip(
    peer_host: Optional[str],
    x_real_ip: Optional[str],
    trusted_proxies: Sequence[IPNetwork],
) -> str:
    """Resolve a stable client key without trusting arbitrary forwarded chains."""
    peer_address = _parse_ip(peer_host)
    if peer_address is None:
        return "unknown"

    if _is_trusted_proxy(peer_address, trusted_proxies):
        forwarded_address = _parse_ip(x_real_ip)
        if forwarded_address is not None:
            return forwarded_address.compressed
    return peer_address.compressed


def _parse_ip(value: Optional[str]) -> Optional[IPAddress]:
    if not value:
        return None
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def _is_trusted_proxy(address: IPAddress, networks: Sequence[IPNetwork]) -> bool:
    return any(
        address.version == network.version and address in network
        for network in networks
    )
