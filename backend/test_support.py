import os


TEST_ADMIN_PASSWORD = "test-admin-password"
TEST_ADMIN_PASSWORD_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$"
    "1xvW/MfYO91OgDrX8CBsAw$"
    "pEIK2pYFXcEfhMzlKVSeEiLJElequU1Ky4LPBzc1bG0"
)


def configure_test_environment() -> None:
    """Make application imports independent of ambient credentials and dotenv."""
    for file_variable in (
        "POSTGRES_PASSWORD_FILE",
        "BLOG_ADMIN_PASSWORD_HASH_FILE",
        "APP_SECRET_KEY_FILE",
    ):
        os.environ.pop(file_variable, None)
    os.environ.update(
        {
            "PORTFOLIO_DISABLE_DOTENV": "true",
            "POSTGRES_USER": "test",
            "POSTGRES_PASSWORD": "test-database-password",
            "POSTGRES_DB": "test",
            "POSTGRES_HOST": "127.0.0.1",
            "ADMIN_ENABLED": "true",
            "BLOG_ADMIN_PASSWORD_HASH": TEST_ADMIN_PASSWORD_HASH,
            "APP_SECRET_KEY": "test-session-secret-key-value-32-bytes",
        }
    )
