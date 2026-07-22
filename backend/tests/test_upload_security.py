import asyncio
import io
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from test_support import configure_test_environment

configure_test_environment()

import anyio
from fastapi import HTTPException, UploadFile
from PIL import Image
from starlette.datastructures import Headers

with patch("fastapi.dependencies.utils.ensure_multipart_is_installed"):
    from app.api import content
from app.core.upload_security import InvalidImageError, verify_image_file


def png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


def animated_gif_bytes() -> bytes:
    buffer = io.BytesIO()
    frames = [Image.new("RGB", (1, 1), color) for color in ("red", "green", "blue")]
    frames[0].save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=10,
        loop=0,
    )
    return buffer.getvalue()


def upload_file(data: bytes, filename: str = "image.png") -> UploadFile:
    return UploadFile(
        file=io.BytesIO(data),
        filename=filename,
        headers=Headers({"content-type": "image/png"}),
    )


class ImageVerificationTests(unittest.TestCase):
    def test_real_format_is_detected_without_trusting_extension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "declared-as-jpeg.jpg"
            path.write_bytes(png_bytes())
            verified = verify_image_file(
                path,
                max_pixels=100,
                max_dimension=10,
                max_frames=10,
                max_total_pixels=1_000,
            )
        self.assertEqual(verified.extension, ".png")
        self.assertEqual(verified.content_type, "image/png")
        self.assertEqual((verified.width, verified.height), (1, 1))

    def test_forged_image_and_oversized_dimensions_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            forged = Path(directory) / "fake.png"
            forged.write_bytes(b"not an image")
            with self.assertRaises(InvalidImageError):
                verify_image_file(
                    forged,
                    max_pixels=100,
                    max_dimension=10,
                    max_frames=10,
                    max_total_pixels=1_000,
                )

            real = Path(directory) / "real.png"
            real.write_bytes(png_bytes())
            with self.assertRaises(InvalidImageError):
                verify_image_file(
                    real,
                    max_pixels=0,
                    max_dimension=10,
                    max_frames=10,
                    max_total_pixels=1_000,
                )

    def test_animated_image_frame_and_total_pixel_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            animated = Path(directory) / "animated.gif"
            animated.write_bytes(animated_gif_bytes())
            with self.assertRaises(InvalidImageError):
                verify_image_file(
                    animated,
                    max_pixels=100,
                    max_dimension=10,
                    max_frames=2,
                    max_total_pixels=1_000,
                )
            with self.assertRaises(InvalidImageError):
                verify_image_file(
                    animated,
                    max_pixels=100,
                    max_dimension=10,
                    max_frames=10,
                    max_total_pixels=2,
                )

    def test_upload_uses_verified_type_and_failure_releases_resources(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ):
            async def exercise() -> tuple[HTTPException, dict[str, object], bool, bool]:
                invalid = upload_file(b"not an image", "fake.png")
                valid = upload_file(png_bytes(), "spoofed.jpg")
                limiter = anyio.CapacityLimiter(1)
                with patch.object(content, "UPLOAD_PROCESSING_LIMITER", limiter):
                    try:
                        await content.upload_image(invalid)
                    except HTTPException as error:
                        rejected = error
                    else:
                        self.fail("Invalid image upload was accepted")

                    # A failed worker must return its sole limiter token so the
                    # next upload can start instead of waiting indefinitely.
                    result = await asyncio.wait_for(content.upload_image(valid), timeout=1)
                return rejected, result, invalid.file.closed, valid.file.closed

            rejected, result, invalid_closed, valid_closed = asyncio.run(exercise())
            self.assertEqual(rejected.status_code, 400)
            self.assertEqual(result["contentType"], "image/png")
            self.assertTrue(str(result["filename"]).endswith(".png"))
            self.assertTrue(invalid_closed)
            self.assertTrue(valid_closed)
            self.assertFalse(
                any(path.name.startswith(".upload-") for path in Path(directory).iterdir())
            )

    def test_upload_size_limit_is_streamed_and_temporary_file_is_removed(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(content.settings, "UPLOAD_DIR", directory),
            patch.object(content.settings, "MAX_UPLOAD_MB", 1),
            patch.object(content, "verify_image_file") as verification,
        ):
            oversized = upload_file(b"x" * (1024 * 1024 + 1))
            with self.assertRaises(HTTPException) as rejected:
                asyncio.run(content.upload_image(oversized))

            self.assertEqual(rejected.exception.status_code, 413)
            self.assertTrue(oversized.file.closed)
            verification.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_upload_rejects_a_full_media_inventory_before_processing(self) -> None:
        existing_filename = "a" * 32 + ".png"
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(content.settings, "UPLOAD_DIR", directory),
            patch.object(content.settings, "MAX_MEDIA_FILES", 1),
            patch.object(content, "verify_image_file") as verification,
        ):
            Path(directory, existing_filename).write_bytes(b"existing")
            image = upload_file(png_bytes())
            with self.assertRaises(HTTPException) as rejected:
                asyncio.run(content.upload_image(image))

            self.assertEqual(rejected.exception.status_code, 409)
            self.assertEqual(
                rejected.exception.detail,
                content.MEDIA_INVENTORY_LIMIT_DETAIL,
            )
            self.assertTrue(image.file.closed)
            verification.assert_not_called()
            self.assertEqual(
                [path.name for path in Path(directory).iterdir()],
                [existing_filename],
            )

    def test_unexpected_directory_entry_conservatively_consumes_inventory(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(content.settings, "UPLOAD_DIR", directory),
            patch.object(content.settings, "MAX_MEDIA_FILES", 1),
            patch.object(content, "verify_image_file") as verification,
        ):
            unexpected = Path(directory, "orphaned-entry")
            unexpected.write_bytes(b"unexpected")
            image = upload_file(png_bytes())

            with self.assertRaises(HTTPException) as rejected:
                asyncio.run(content.upload_image(image))

            self.assertEqual(rejected.exception.status_code, 409)
            self.assertTrue(image.file.closed)
            verification.assert_not_called()
            self.assertTrue(unexpected.exists())
            self.assertEqual(content._PENDING_MEDIA_UPLOADS, 0)

    def test_concurrent_upload_reservations_cannot_exceed_inventory_limit(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(content.settings, "UPLOAD_DIR", directory),
            patch.object(content.settings, "MAX_MEDIA_FILES", 1),
        ):
            original_verify = content.verify_image_file
            first_started = threading.Event()
            release_first = threading.Event()

            def blocking_verify(*args, **kwargs):
                first_started.set()
                if not release_first.wait(timeout=2):
                    raise AssertionError("Timed out waiting to release first upload")
                return original_verify(*args, **kwargs)

            async def exercise() -> tuple[dict[str, object], HTTPException, bool]:
                limiter = anyio.CapacityLimiter(2)
                first_image = upload_file(png_bytes())
                second_image = upload_file(png_bytes())
                with (
                    patch.object(content, "UPLOAD_PROCESSING_LIMITER", limiter),
                    patch.object(content, "verify_image_file", side_effect=blocking_verify),
                ):
                    first_task = asyncio.create_task(content.upload_image(first_image))
                    for _ in range(200):
                        if first_started.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(first_started.is_set())

                    try:
                        await asyncio.wait_for(content.upload_image(second_image), timeout=1)
                    except HTTPException as error:
                        rejected = error
                    else:
                        self.fail("Second concurrent upload exceeded the media inventory")
                    finally:
                        release_first.set()

                    first_result = await first_task
                return first_result, rejected, second_image.file.closed

            first_result, rejected, second_closed = asyncio.run(exercise())

            self.assertEqual(rejected.status_code, 409)
            self.assertEqual(
                rejected.detail,
                content.MEDIA_INVENTORY_LIMIT_DETAIL,
            )
            self.assertTrue(second_closed)
            self.assertEqual(first_result["contentType"], "image/png")
            self.assertEqual(content._PENDING_MEDIA_UPLOADS, 0)
            self.assertEqual(
                len(
                    [
                        path
                        for path in Path(directory).iterdir()
                        if content.UPLOAD_FILENAME_PATTERN.fullmatch(path.name)
                    ]
                ),
                1,
            )

    def test_pending_temporary_file_is_not_counted_as_published_media(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(content.settings, "UPLOAD_DIR", directory),
            patch.object(content.settings, "MAX_MEDIA_FILES", 2),
        ):
            original_verify = content.verify_image_file
            first_started = threading.Event()
            release_first = threading.Event()
            call_lock = threading.Lock()
            calls = 0

            def block_only_first_verify(*args, **kwargs):
                nonlocal calls
                with call_lock:
                    calls += 1
                    call_number = calls
                if call_number == 1:
                    first_started.set()
                    if not release_first.wait(timeout=2):
                        raise AssertionError("Timed out waiting to release first upload")
                return original_verify(*args, **kwargs)

            async def exercise() -> list[dict[str, object]]:
                limiter = anyio.CapacityLimiter(2)
                with (
                    patch.object(content, "UPLOAD_PROCESSING_LIMITER", limiter),
                    patch.object(
                        content,
                        "verify_image_file",
                        side_effect=block_only_first_verify,
                    ),
                ):
                    first_task = asyncio.create_task(
                        content.upload_image(upload_file(png_bytes()))
                    )
                    for _ in range(200):
                        if first_started.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(first_started.is_set())

                    try:
                        second_result = await asyncio.wait_for(
                            content.upload_image(upload_file(png_bytes())),
                            timeout=1,
                        )
                    finally:
                        release_first.set()
                    first_result = await first_task
                return [first_result, second_result]

            results = asyncio.run(exercise())

            self.assertEqual(len(results), 2)
            self.assertEqual(content._PENDING_MEDIA_UPLOADS, 0)
            self.assertEqual(
                len(
                    [
                        path
                        for path in Path(directory).iterdir()
                        if content.UPLOAD_FILENAME_PATTERN.fullmatch(path.name)
                    ]
                ),
                2,
            )

    def test_upload_processing_respects_concurrency_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ):
            original_verify = content.verify_image_file
            first_started = threading.Event()
            release_first = threading.Event()
            state_lock = threading.Lock()
            calls = 0
            active = 0
            max_active = 0

            def gated_verify(*args, **kwargs):
                nonlocal calls, active, max_active
                with state_lock:
                    calls += 1
                    call_number = calls
                    active += 1
                    max_active = max(max_active, active)
                try:
                    if call_number == 1:
                        first_started.set()
                        if not release_first.wait(timeout=2):
                            raise AssertionError("Timed out waiting to release image verification")
                    return original_verify(*args, **kwargs)
                finally:
                    with state_lock:
                        active -= 1

            async def exercise() -> tuple[list[dict[str, object]], tuple[int, int]]:
                limiter = anyio.CapacityLimiter(1)
                with (
                    patch.object(content, "UPLOAD_PROCESSING_LIMITER", limiter),
                    patch.object(content, "verify_image_file", side_effect=gated_verify),
                ):
                    tasks = [
                        asyncio.create_task(
                            content.upload_image(upload_file(png_bytes()))
                        )
                        for _ in range(2)
                    ]
                    try:
                        for _ in range(200):
                            if first_started.is_set():
                                break
                            await asyncio.sleep(0.005)
                        await asyncio.sleep(0.05)
                        with state_lock:
                            waiting_snapshot = (calls, max_active)
                    finally:
                        release_first.set()
                    results = await asyncio.gather(*tasks)
                return results, waiting_snapshot

            results, waiting_snapshot = asyncio.run(exercise())
            self.assertEqual(waiting_snapshot, (1, 1))
            self.assertEqual(calls, 2)
            self.assertEqual(max_active, 1)
            self.assertEqual(len(results), 2)
            self.assertFalse(
                any(path.name.startswith(".upload-") for path in Path(directory).iterdir())
            )

    def test_slow_image_decode_does_not_block_event_loop(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.object(
            content.settings,
            "UPLOAD_DIR",
            directory,
        ):
            original_verify = content.verify_image_file
            decode_started = threading.Event()
            release_decode = threading.Event()

            def blocking_verify(*args, **kwargs):
                decode_started.set()
                if not release_decode.wait(timeout=1):
                    raise AssertionError("Timed out waiting to release image verification")
                return original_verify(*args, **kwargs)

            async def exercise() -> tuple[dict[str, object], bool]:
                limiter = anyio.CapacityLimiter(1)
                with (
                    patch.object(content, "UPLOAD_PROCESSING_LIMITER", limiter),
                    patch.object(content, "verify_image_file", side_effect=blocking_verify),
                ):
                    task = asyncio.create_task(content.upload_image(upload_file(png_bytes())))
                    try:
                        for _ in range(200):
                            if decode_started.is_set():
                                break
                            await asyncio.sleep(0.005)
                        await asyncio.sleep(0.02)
                        upload_still_running = not task.done()
                    finally:
                        release_decode.set()
                    result = await task
                return result, upload_still_running

            result, upload_still_running = asyncio.run(exercise())
            self.assertTrue(decode_started.is_set())
            self.assertTrue(upload_still_running)
            self.assertEqual(result["contentType"], "image/png")


if __name__ == "__main__":
    unittest.main()
