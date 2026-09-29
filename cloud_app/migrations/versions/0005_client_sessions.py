"""Independent mobile clients and single-use QR enrollment."""
from alembic import op
import sqlalchemy as sa

revision = "0005_client_sessions"
down_revision = "0004_device_authorization"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("client_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("access_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("refresh_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("access_expires_at", sa.Integer(), nullable=False),
        sa.Column("refresh_expires_at", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("last_seen_at", sa.Integer()),
        sa.Column("revoked_at", sa.Integer()))
    op.create_index("ix_client_sessions_owner_id", "client_sessions", ["owner_id"])
    op.create_table("client_enrollments",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("used_at", sa.Integer()))
    op.create_index("ix_client_enrollments_owner_id", "client_enrollments", ["owner_id"])
    op.create_table("used_client_refresh_tokens",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("client_sessions.id"), nullable=False),
        sa.Column("used_at", sa.Integer(), nullable=False))
    op.create_index("ix_used_client_refresh_tokens_session_id", "used_client_refresh_tokens", ["session_id"])


def downgrade() -> None:
    op.drop_table("used_client_refresh_tokens")
    op.drop_table("client_enrollments")
    op.drop_table("client_sessions")
