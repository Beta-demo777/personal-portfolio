from __future__ import annotations

import errno
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import restore_uploads  # noqa: E402


LARGE_MEDIA_BYTES = 72 * 1024 * 1024
TOKEN = "0123456789abcdef0123456789abcdef"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class RestoreUploadsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _archive(self, source: Path) -> Path:
        archive_path = self.base / f"archive-{len(list(self.base.glob('archive-*')))}.tar"
        with archive_path.open("wb") as output:
            restore_uploads.create_archive(source, output)
        return archive_path

    def test_archive_omits_known_upload_temporary_files(self) -> None:
        source = self.base / "source"
        source.mkdir()
        final_name = "a" * 32 + ".png"
        (source / final_name).write_bytes(b"final-media")
        (source / ".upload-abcd_1234.tmp").write_bytes(b"partial-media")

        archive_path = self._archive(source)
        with archive_path.open("rb") as archive_file:
            summary = restore_uploads.read_archive(archive_file)

        self.assertEqual(summary.files, 1)
        self.assertEqual(summary.total_bytes, len(b"final-media"))
        with tarfile.open(archive_path) as archive:
            self.assertEqual(archive.getnames(), [final_name])

    def test_round_trip_archive_larger_than_container_tmpfs(self) -> None:
        source = self.base / "large-source"
        source.mkdir()
        large_name = "b" * 32 + ".gif"
        large_file = source / large_name
        # A valid 1x1 GIF followed by ignored trailing bytes keeps the fixture
        # cheap to generate while exercising a genuinely >70 MiB tar stream.
        large_file.write_bytes(
            b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00"
            b"\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00"
            b"\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
        )
        with large_file.open("r+b") as output:
            output.truncate(LARGE_MEDIA_BYTES)
        expected_hash = sha256_file(large_file)

        archive_path = self._archive(source)
        self.assertGreater(archive_path.stat().st_size, 70 * 1024 * 1024)
        live = self.base / "live"
        live.mkdir()
        old_name = "c" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")

        with archive_path.open("rb") as archive_file:
            staged = restore_uploads.stage_archive(live, TOKEN, archive_file)
        self.assertEqual(staged.total_bytes, LARGE_MEDIA_BYTES)
        restore_uploads.activate_staged_archive(live, TOKEN)
        restore_uploads.finalize_active_archive(live, TOKEN)

        self.assertFalse((live / old_name).exists())
        self.assertEqual((live / large_name).stat().st_size, LARGE_MEDIA_BYTES)
        self.assertEqual(sha256_file(live / large_name), expected_hash)
        self.assertFalse(any(path.name.startswith(restore_uploads.TRANSACTION_PREFIX) for path in live.iterdir()))

    def test_activation_failure_restores_every_original_entry(self) -> None:
        source = self.base / "replacement"
        source.mkdir()
        shared_name = "d" * 32 + ".webp"
        new_name = "e" * 32 + ".png"
        (source / shared_name).write_bytes(b"new-shared")
        (source / new_name).write_bytes(b"new-only")
        archive_path = self._archive(source)

        live = self.base / "failure-live"
        live.mkdir()
        old_name = "f" * 32 + ".jpg"
        (live / shared_name).write_bytes(b"old-shared")
        (live / old_name).write_bytes(b"old-only")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)

        def fail_after_new_media(checkpoint: str) -> None:
            if checkpoint == "after_new_media_moved":
                raise RuntimeError("injected activation failure")

        with self.assertRaisesRegex(RuntimeError, "injected activation failure"):
            restore_uploads.activate_staged_archive(live, TOKEN, failure_hook=fail_after_new_media)

        self.assertEqual((live / shared_name).read_bytes(), b"old-shared")
        self.assertEqual((live / old_name).read_bytes(), b"old-only")
        self.assertFalse((live / new_name).exists())
        self.assertFalse(any(path.name.startswith(restore_uploads.TRANSACTION_PREFIX) for path in live.iterdir()))

    def test_recover_rollback_is_idempotent_for_staged_and_active_media(self) -> None:
        source = self.base / "recover-source"
        source.mkdir()
        new_name = "1" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "recover-live"
        live.mkdir()
        old_name = "2" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")

        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertEqual((live / old_name).read_bytes(), b"old-media")
        self.assertFalse((live / new_name).exists())

        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertEqual((live / old_name).read_bytes(), b"old-media")
        self.assertFalse((live / new_name).exists())
        self.assertFalse(any(path.name.startswith(restore_uploads.TRANSACTION_PREFIX) for path in live.iterdir()))

    def test_recover_rollback_converges_a_partially_activated_transaction(self) -> None:
        source = self.base / "partial-source"
        source.mkdir()
        shared_name = "3" * 32 + ".webp"
        new_name = "4" * 32 + ".png"
        (source / shared_name).write_bytes(b"new-shared")
        (source / new_name).write_bytes(b"new-only")
        archive_path = self._archive(source)
        live = self.base / "partial-live"
        live.mkdir()
        old_name = "5" * 32 + ".jpg"
        (live / shared_name).write_bytes(b"old-shared")
        (live / old_name).write_bytes(b"old-only")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)

        paths = restore_uploads.transaction_paths(live, TOKEN)
        paths.rollback.mkdir(mode=0o700)
        paths.old.mkdir(mode=0o700)
        restore_uploads._write_state(
            paths,
            [old_name, shared_name],
            [new_name, shared_name],
        )
        os.replace(live / old_name, paths.old / old_name)
        os.replace(live / shared_name, paths.old / shared_name)
        os.replace(paths.stage / new_name, live / new_name)

        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)

        self.assertEqual((live / shared_name).read_bytes(), b"old-shared")
        self.assertEqual((live / old_name).read_bytes(), b"old-only")
        self.assertFalse((live / new_name).exists())

    def test_recover_rollback_discards_activation_killed_before_state_publish(self) -> None:
        source = self.base / "unpublished-source"
        source.mkdir()
        new_name = "6" * 32 + ".gif"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "unpublished-live"
        live.mkdir()
        old_name = "7" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)

        paths = restore_uploads.transaction_paths(live, TOKEN)
        paths.rollback.mkdir(mode=0o700)
        paths.old.mkdir(mode=0o700)
        paths.state_temporary.write_text("partial", encoding="ascii")

        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertEqual((live / old_name).read_bytes(), b"old-media")
        self.assertFalse((live / new_name).exists())

    def test_recover_commit_is_idempotent_and_rejects_ambiguous_state(self) -> None:
        source = self.base / "commit-source"
        source.mkdir()
        new_name = "8" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "commit-live"
        live.mkdir()
        old_name = "9" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)

        restore_uploads.recover_commit_archive(live, TOKEN)
        restore_uploads.recover_commit_archive(live, TOKEN)
        self.assertFalse((live / old_name).exists())
        self.assertEqual((live / new_name).read_bytes(), b"new-media")

        paths = restore_uploads.transaction_paths(live, TOKEN)
        paths.stage.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, "staging data without rollback"):
            restore_uploads.recover_commit_archive(live, TOKEN)
        self.assertTrue(paths.stage.is_dir())

    def test_recover_commit_finishes_a_partially_removed_cleanup_tombstone(self) -> None:
        source = self.base / "commit-cleanup-source"
        source.mkdir()
        new_name = "a" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "commit-cleanup-live"
        live.mkdir()
        old_name = "b" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        paths = restore_uploads.transaction_paths(live, TOKEN)
        real_remove = restore_uploads._remove_tree_durable

        def interrupt_cleanup(directory: Path) -> None:
            if directory == paths.commit_cleanup:
                paths.commit_cleanup.joinpath("state.json").unlink()
                restore_uploads.shutil.rmtree(paths.commit_cleanup / "old")
                raise OSError(errno.EIO, "injected cleanup interruption")
            real_remove(directory)

        with mock.patch.object(
            restore_uploads,
            "_remove_tree_durable",
            side_effect=interrupt_cleanup,
        ), self.assertRaisesRegex(OSError, "injected cleanup interruption"):
            restore_uploads.finalize_active_archive(live, TOKEN)

        self.assertFalse(paths.rollback.exists())
        self.assertTrue(paths.commit_cleanup.is_dir())
        self.assertFalse((paths.commit_cleanup / "state.json").exists())
        self.assertEqual((live / new_name).read_bytes(), b"new-media")
        self.assertFalse((live / old_name).exists())

        restore_uploads.recover_commit_archive(live, TOKEN)
        restore_uploads.recover_commit_archive(live, TOKEN)
        self.assertFalse(paths.commit_cleanup.exists())
        self.assertEqual((live / new_name).read_bytes(), b"new-media")

    def test_recover_rollback_finishes_a_partially_removed_cleanup_tombstone(self) -> None:
        source = self.base / "rollback-cleanup-source"
        source.mkdir()
        new_name = "c" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "rollback-cleanup-live"
        live.mkdir()
        old_name = "d" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        paths = restore_uploads.transaction_paths(live, TOKEN)
        real_remove = restore_uploads._remove_tree_durable

        def interrupt_cleanup(directory: Path) -> None:
            if directory == paths.rollback_cleanup:
                paths.rollback_cleanup.joinpath("state.json").unlink()
                restore_uploads.shutil.rmtree(paths.rollback_cleanup / "old")
                raise OSError(errno.EIO, "injected cleanup interruption")
            real_remove(directory)

        with mock.patch.object(
            restore_uploads,
            "_remove_tree_durable",
            side_effect=interrupt_cleanup,
        ), self.assertRaisesRegex(OSError, "injected cleanup interruption"):
            restore_uploads.rollback_active_archive(live, TOKEN)

        self.assertFalse(paths.rollback.exists())
        self.assertTrue(paths.rollback_cleanup.is_dir())
        self.assertFalse((paths.rollback_cleanup / "state.json").exists())
        self.assertEqual((live / old_name).read_bytes(), b"old-media")
        self.assertFalse((live / new_name).exists())

        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertFalse(paths.rollback_cleanup.exists())
        self.assertEqual((live / old_name).read_bytes(), b"old-media")

    def test_recover_rollback_finishes_partial_stage_after_cleanup_publish(self) -> None:
        source = self.base / "rollback-stage-cleanup-source"
        source.mkdir()
        first_new_name = "e" * 32 + ".png"
        second_new_name = "f" * 32 + ".webp"
        (source / first_new_name).write_bytes(b"first-new-media")
        (source / second_new_name).write_bytes(b"second-new-media")
        archive_path = self._archive(source)
        live = self.base / "rollback-stage-cleanup-live"
        live.mkdir()
        old_name = "0" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        paths = restore_uploads.transaction_paths(live, TOKEN)
        real_remove = restore_uploads._remove_tree_durable

        def interrupt_stage_cleanup(directory: Path) -> None:
            if directory == paths.stage:
                (paths.stage / first_new_name).unlink()
                raise OSError(errno.EIO, "injected stage cleanup interruption")
            real_remove(directory)

        with mock.patch.object(
            restore_uploads,
            "_remove_tree_durable",
            side_effect=interrupt_stage_cleanup,
        ), self.assertRaisesRegex(OSError, "injected stage cleanup interruption"):
            restore_uploads.rollback_active_archive(live, TOKEN)

        self.assertTrue(paths.rollback_cleanup.is_dir())
        self.assertTrue(paths.stage.is_dir())
        self.assertFalse((paths.stage / first_new_name).exists())
        self.assertTrue((paths.stage / second_new_name).is_file())
        self.assertEqual((live / old_name).read_bytes(), b"old-media")

        restore_uploads.recover_rollback_archive(live, TOKEN)
        restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertFalse(paths.stage.exists())
        self.assertFalse(paths.rollback_cleanup.exists())
        self.assertEqual((live / old_name).read_bytes(), b"old-media")

    def test_cleanup_tombstones_fail_closed_for_wrong_outcome_and_symlinks(self) -> None:
        live = self.base / "cleanup-boundary-live"
        live.mkdir()
        paths = restore_uploads.transaction_paths(live, TOKEN)
        paths.commit_cleanup.mkdir(mode=0o700)

        with self.assertRaisesRegex(RuntimeError, "does not match rollback"):
            restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertTrue(paths.commit_cleanup.is_dir())

        paths.commit_cleanup.rmdir()
        target = self.base / "outside-cleanup-target"
        target.mkdir()
        marker = target / "must-survive"
        marker.write_bytes(b"outside")
        paths.commit_cleanup.symlink_to(target, target_is_directory=True)

        with self.assertRaisesRegex(RuntimeError, "not a real directory"):
            restore_uploads.recover_commit_archive(live, TOKEN)
        self.assertEqual(marker.read_bytes(), b"outside")
        self.assertTrue(paths.commit_cleanup.is_symlink())

        paths.commit_cleanup.unlink()
        other_paths = restore_uploads.transaction_paths(live, "f" * 32)
        other_paths.rollback_cleanup.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, "another uploads restore transaction"):
            restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertTrue(other_paths.rollback_cleanup.is_dir())

    def test_recover_fails_closed_on_corrupt_transaction_state(self) -> None:
        source = self.base / "corrupt-source"
        source.mkdir()
        (source / ("a" * 32 + ".png")).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "corrupt-live"
        live.mkdir()
        old_name = "b" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        paths = restore_uploads.transaction_paths(live, TOKEN)
        paths.state.write_text('{"version":1', encoding="ascii")

        with self.assertRaises(json.JSONDecodeError):
            restore_uploads.recover_rollback_archive(live, TOKEN)
        self.assertTrue(paths.rollback.is_dir())
        self.assertFalse((live / old_name).exists())

    def test_member_policy_rejects_upload_temporary_file_in_archive(self) -> None:
        archive_buffer = io.BytesIO()
        with tarfile.open(fileobj=archive_buffer, mode="w") as archive:
            payload = b"partial"
            member = tarfile.TarInfo(".upload-unfinished.tmp")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        archive_buffer.seek(0)

        with self.assertRaisesRegex(ValueError, "unsupported archive entry"):
            restore_uploads.read_archive(archive_buffer)

    def test_capacity_preflight_rejects_space_shortage_without_writing(self) -> None:
        source = self.base / "capacity-source"
        source.mkdir()
        filename = "1" * 32 + ".png"
        (source / filename).write_bytes(b"replacement")
        archive_path = self._archive(source)
        live = self.base / "capacity-live"
        live.mkdir()
        old_file = live / ("2" * 32 + ".jpg")
        old_file.write_bytes(b"current")
        capacity = restore_uploads.FilesystemCapacity(
            device_id=1,
            total_bytes=1024 * 1024 * 1024,
            available_bytes=restore_uploads.MIN_FREE_BYTES_AFTER_STAGE,
            available_inodes=10_000,
        )

        with archive_path.open("rb") as archive_file, self.assertRaisesRegex(
            RuntimeError,
            "insufficient free space",
        ):
            restore_uploads.preflight_archive_capacity(
                live,
                archive_file,
                capacity=capacity,
            )

        self.assertEqual(list(live.iterdir()), [old_file])
        self.assertEqual(old_file.read_bytes(), b"current")

    def test_capacity_preflight_rejects_inode_shortage(self) -> None:
        summary = restore_uploads.ArchiveSummary(files=2, total_bytes=1)
        capacity = restore_uploads.FilesystemCapacity(
            device_id=1,
            total_bytes=10 * 1024 * 1024 * 1024,
            available_bytes=10 * 1024 * 1024 * 1024,
            available_inodes=summary.files + restore_uploads.MIN_FREE_INODES_AFTER_STAGE - 1,
        )

        with self.assertRaisesRegex(RuntimeError, "insufficient free inodes"):
            restore_uploads.ensure_archive_capacity(
                self.base,
                summary,
                capacity=capacity,
            )

    def test_capacity_preflight_accepts_exact_required_capacity(self) -> None:
        summary = restore_uploads.ArchiveSummary(files=2, total_bytes=1024)
        total_bytes = 1024 * 1024 * 1024
        reserve = max(
            restore_uploads.MIN_FREE_BYTES_AFTER_STAGE,
            (total_bytes + 19) // 20,
        )
        capacity = restore_uploads.FilesystemCapacity(
            device_id=1,
            total_bytes=total_bytes,
            available_bytes=summary.total_bytes + reserve,
            available_inodes=summary.files + restore_uploads.MIN_FREE_INODES_AFTER_STAGE,
        )

        restore_uploads.ensure_archive_capacity(
            self.base,
            summary,
            capacity=capacity,
        )

    def test_stage_and_activation_fsync_every_changed_parent_directory(self) -> None:
        source = self.base / "durable-source"
        source.mkdir()
        new_name = "c" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "durable-live"
        live.mkdir()
        old_name = "d" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        paths = restore_uploads.transaction_paths(live, TOKEN)
        real_fsync_directory = restore_uploads._fsync_directory
        synced: list[Path] = []

        def record_fsync(directory: Path) -> None:
            synced.append(directory)
            real_fsync_directory(directory)

        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=record_fsync,
        ):
            with archive_path.open("rb") as archive_file:
                restore_uploads.stage_archive(live, TOKEN, archive_file)
        self.assertEqual(synced, [live, paths.stage])

        synced.clear()
        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=record_fsync,
        ):
            restore_uploads.activate_staged_archive(live, TOKEN)
        self.assertEqual(
            synced,
            [
                live,
                paths.rollback,
                paths.rollback,
                live,
                paths.old,
                paths.stage,
                live,
            ],
        )

    def test_rollback_fsyncs_move_and_cleanup_parent_directories(self) -> None:
        source = self.base / "rollback-durable-source"
        source.mkdir()
        new_name = "e" * 32 + ".webp"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "rollback-durable-live"
        live.mkdir()
        old_name = "f" * 32 + ".gif"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        paths = restore_uploads.transaction_paths(live, TOKEN)
        real_fsync_directory = restore_uploads._fsync_directory
        synced: list[Path] = []

        def record_fsync(directory: Path) -> None:
            synced.append(directory)
            real_fsync_directory(directory)

        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=record_fsync,
        ):
            restore_uploads.rollback_active_archive(live, TOKEN)

        self.assertEqual(
            synced,
            [live, paths.stage, paths.old, live, live, live, live],
        )
        self.assertEqual((live / old_name).read_bytes(), b"old-media")
        self.assertFalse((live / new_name).exists())

    def test_finalize_and_discard_fsync_root_after_directory_removal(self) -> None:
        source = self.base / "cleanup-durable-source"
        source.mkdir()
        new_name = "0" * 32 + ".png"
        (source / new_name).write_bytes(b"new-media")
        archive_path = self._archive(source)
        live = self.base / "cleanup-durable-live"
        live.mkdir()
        old_name = "1" * 32 + ".jpg"
        (live / old_name).write_bytes(b"old-media")
        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        restore_uploads.activate_staged_archive(live, TOKEN)
        real_fsync_directory = restore_uploads._fsync_directory
        synced: list[Path] = []

        def record_fsync(directory: Path) -> None:
            synced.append(directory)
            real_fsync_directory(directory)

        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=record_fsync,
        ):
            restore_uploads.finalize_active_archive(live, TOKEN)
        self.assertEqual(synced, [live, live, live])

        with archive_path.open("rb") as archive_file:
            restore_uploads.stage_archive(live, TOKEN, archive_file)
        synced.clear()
        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=record_fsync,
        ):
            restore_uploads.discard_staged_archive(live, TOKEN)
        self.assertEqual(synced, [live])

    @unittest.skipIf(os.name == "nt", "directory fsync is intentionally unavailable")
    def test_directory_fsync_ignores_only_unsupported_errors(self) -> None:
        unsupported = OSError(errno.EINVAL, "directory fsync is unsupported")
        with mock.patch.object(restore_uploads.os, "fsync", side_effect=unsupported):
            restore_uploads._fsync_directory(self.base)

        failure = OSError(errno.EIO, "storage I/O failure")
        with mock.patch.object(restore_uploads.os, "fsync", side_effect=failure):
            with self.assertRaises(OSError) as raised:
                restore_uploads._fsync_directory(self.base)
        self.assertEqual(raised.exception.errno, errno.EIO)

    def test_cross_directory_fsync_attempts_both_parents_after_failure(self) -> None:
        source_parent = self.base / "source-parent"
        destination_parent = self.base / "destination-parent"
        first_failure = OSError(errno.EIO, "source directory fsync failed")
        with mock.patch.object(
            restore_uploads,
            "_fsync_directory",
            side_effect=[first_failure, None],
        ) as fsync_directory:
            with self.assertRaises(OSError) as raised:
                restore_uploads._fsync_directories(source_parent, destination_parent)

        self.assertIs(raised.exception, first_failure)
        self.assertEqual(
            fsync_directory.call_args_list,
            [mock.call(source_parent), mock.call(destination_parent)],
        )


if __name__ == "__main__":
    unittest.main()
