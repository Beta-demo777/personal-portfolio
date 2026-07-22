from __future__ import annotations

from pathlib import Path
import sys
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import restore_capacity  # noqa: E402


class RestoreCapacityTests(unittest.TestCase):
    def test_database_requirement_includes_expansion_wal_and_reserve(self) -> None:
        requirement = restore_capacity.database_capacity_requirement(
            dump_bytes=100,
            plain_bytes=200,
            toc_entries=10,
            filesystem_total_bytes=2 * 1024 * 1024 * 1024,
        )

        self.assertEqual(
            requirement.required_bytes,
            200 * restore_capacity.DATABASE_EXPANSION_AND_WAL_FACTOR
            + restore_capacity.MIN_DATABASE_RESERVE_BYTES,
        )
        self.assertEqual(
            requirement.required_inodes,
            restore_capacity.MIN_DATABASE_RESERVE_INODES,
        )

    def test_database_requirement_uses_proportional_reserve_on_large_volume(self) -> None:
        total_bytes = 100 * 1024 * 1024 * 1024
        requirement = restore_capacity.database_capacity_requirement(
            dump_bytes=1,
            plain_bytes=1,
            toc_entries=1,
            filesystem_total_bytes=total_bytes,
        )

        self.assertEqual(
            requirement.required_bytes,
            restore_capacity.DATABASE_EXPANSION_AND_WAL_FACTOR + total_bytes // 20,
        )

    def test_database_capacity_rejects_space_and_inode_shortages(self) -> None:
        requirement = restore_capacity.DatabaseCapacityRequirement(
            required_bytes=100,
            required_inodes=20,
        )

        with self.assertRaisesRegex(RuntimeError, "insufficient free space"):
            restore_capacity.ensure_database_capacity(
                requirement,
                available_bytes=99,
                available_inodes=20,
            )
        with self.assertRaisesRegex(RuntimeError, "insufficient free inodes"):
            restore_capacity.ensure_database_capacity(
                requirement,
                available_bytes=100,
                available_inodes=19,
            )

        restore_capacity.ensure_database_capacity(
            requirement,
            available_bytes=100,
            available_inodes=20,
        )

    def test_database_requirement_rejects_invalid_inputs(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not be negative"):
            restore_capacity.database_capacity_requirement(
                dump_bytes=-1,
                plain_bytes=0,
                toc_entries=0,
                filesystem_total_bytes=1,
            )

    def test_shared_pool_combines_database_and_upload_staging(self) -> None:
        requirement = restore_capacity.DatabaseCapacityRequirement(
            required_bytes=100,
            required_inodes=20,
        )

        with self.assertRaisesRegex(RuntimeError, "shared data volume.*free space"):
            restore_capacity.ensure_shared_restore_capacity(
                requirement,
                uploads_staging_bytes=50,
                uploads_staging_inodes=5,
                available_bytes=149,
                available_inodes=25,
            )
        with self.assertRaisesRegex(RuntimeError, "shared data volume.*free inodes"):
            restore_capacity.ensure_shared_restore_capacity(
                requirement,
                uploads_staging_bytes=50,
                uploads_staging_inodes=5,
                available_bytes=150,
                available_inodes=24,
            )

        restore_capacity.ensure_shared_restore_capacity(
            requirement,
            uploads_staging_bytes=50,
            uploads_staging_inodes=5,
            available_bytes=150,
            available_inodes=25,
        )

    def test_shared_pool_detection_uses_device_or_matching_capacity(self) -> None:
        common = {
            "database_total_bytes": 1_000,
            "database_available_bytes": 800,
            "uploads_total_bytes": 1_000,
            "uploads_available_bytes": 799,
        }
        self.assertTrue(
            restore_capacity.filesystems_share_capacity(
                database_device=1,
                uploads_device=1,
                **common,
            )
        )
        self.assertTrue(
            restore_capacity.filesystems_share_capacity(
                database_device=1,
                uploads_device=2,
                **common,
            )
        )
        self.assertFalse(
            restore_capacity.filesystems_share_capacity(
                database_device=1,
                uploads_device=2,
                **{**common, "uploads_total_bytes": 2_000},
            )
        )


if __name__ == "__main__":
    unittest.main()
