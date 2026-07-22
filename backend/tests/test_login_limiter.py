import unittest
from concurrent.futures import ThreadPoolExecutor

from app.core.login_limiter import (
    LoginAttemptLimiter,
    parse_trusted_proxy_cidrs,
    resolve_client_ip,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class LoginAttemptLimiterTests(unittest.TestCase):
    def make_limiter(self, clock: FakeClock, **overrides) -> LoginAttemptLimiter:
        options = {
            "max_failures": 3,
            "window_seconds": 60,
            "lockout_seconds": 30,
            "max_clients": 100,
            "clock": clock,
        }
        options.update(overrides)
        return LoginAttemptLimiter(**options)

    def test_locks_at_threshold_and_resets_after_lockout(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock)

        self.assertIsNone(limiter.record_failure("203.0.113.1").retry_after)
        self.assertIsNone(limiter.record_failure("203.0.113.1").retry_after)
        result = limiter.record_failure("203.0.113.1")
        self.assertEqual(result.retry_after, 30)
        self.assertTrue(result.newly_locked)
        clock.advance(0.4)
        self.assertEqual(limiter.retry_after("203.0.113.1"), 30)

        clock.advance(29.6)
        self.assertIsNone(limiter.retry_after("203.0.113.1"))
        self.assertIsNone(limiter.record_failure("203.0.113.1").retry_after)

    def test_failures_outside_window_do_not_accumulate(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock)

        limiter.record_failure("203.0.113.2")
        limiter.record_failure("203.0.113.2")
        clock.advance(60)

        self.assertIsNone(limiter.record_failure("203.0.113.2").retry_after)
        self.assertIsNone(limiter.retry_after("203.0.113.2"))

    def test_success_clear_removes_failure_history(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock)

        limiter.record_failure("203.0.113.3")
        limiter.record_failure("203.0.113.3")
        limiter.clear("203.0.113.3")

        self.assertEqual(limiter.tracked_client_count, 0)
        self.assertIsNone(limiter.record_failure("203.0.113.3").retry_after)

    def test_tracking_capacity_is_bounded(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock, max_clients=2)

        limiter.record_failure("203.0.113.1")
        limiter.record_failure("203.0.113.2")
        limiter.record_failure("203.0.113.3")

        self.assertEqual(limiter.tracked_client_count, 2)

    def test_expired_entries_are_cleaned(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock, window_seconds=10)

        limiter.record_failure("203.0.113.1")
        clock.advance(10)
        limiter.record_failure("203.0.113.2")

        self.assertEqual(limiter.tracked_client_count, 1)

    def test_concurrent_failures_are_not_lost(self) -> None:
        clock = FakeClock()
        limiter = self.make_limiter(clock, max_failures=20)

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(
                executor.map(
                    limiter.record_failure,
                    ["203.0.113.4"] * 20,
                )
            )

        self.assertEqual(
            sum(result.newly_locked for result in results),
            1,
        )
        self.assertEqual(
            sum(result.retry_after is not None for result in results),
            1,
        )
        self.assertEqual(limiter.retry_after("203.0.113.4"), 30)


class ClientIpResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.trusted = parse_trusted_proxy_cidrs("127.0.0.1,172.16.0.0/12")

    def test_uses_real_ip_only_for_trusted_proxy(self) -> None:
        self.assertEqual(
            resolve_client_ip("172.20.0.5", "198.51.100.8", self.trusted),
            "198.51.100.8",
        )

    def test_ignores_spoofed_real_ip_from_untrusted_peer(self) -> None:
        self.assertEqual(
            resolve_client_ip("198.51.100.9", "203.0.113.9", self.trusted),
            "198.51.100.9",
        )

    def test_invalid_forwarded_value_falls_back_to_proxy_ip(self) -> None:
        self.assertEqual(
            resolve_client_ip("172.20.0.5", "198.51.100.8, 203.0.113.8", self.trusted),
            "172.20.0.5",
        )


if __name__ == "__main__":
    unittest.main()
