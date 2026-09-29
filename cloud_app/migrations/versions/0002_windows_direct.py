"""Windows Cloud Direct enrollment, sessions, heartbeat and commands.

Revision ID: 0002_windows_direct
Revises: 0001_platform
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_windows_direct"
down_revision = "0001_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("enrollment_sessions",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_type", sa.String(16), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("used_at", sa.Integer()))
    op.create_index("ix_enrollment_sessions_owner_id", "enrollment_sessions", ["owner_id"])
    op.create_table("device_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("access_hash", sa.String(64), unique=True, nullable=False),
        sa.Column("refresh_hash", sa.String(64), unique=True, nullable=False),
        sa.Column("access_expires_at", sa.Integer(), nullable=False),
        sa.Column("refresh_expires_at", sa.Integer(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("revoked_at", sa.Integer()))
    op.create_index("ix_device_sessions_owner_id", "device_sessions", ["owner_id"])
    op.create_index("ix_device_sessions_device_id", "device_sessions", ["device_id"])
    op.create_table("used_refresh_tokens",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("session_id", sa.String(36), sa.ForeignKey("device_sessions.id"), nullable=False),
        sa.Column("used_at", sa.Integer(), nullable=False))
    op.create_index("ix_used_refresh_tokens_session_id", "used_refresh_tokens", ["session_id"])
    op.create_table("heartbeats",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("seen_at", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("uptime", sa.Integer(), nullable=False),
        sa.Column("lan_ip", sa.String(45), nullable=False),
        sa.Column("wol_capable", sa.Boolean(), nullable=False))
    op.create_index("ix_heartbeats_device_id", "heartbeats", ["device_id"])
    op.create_table("device_commands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("target_device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("nonce", sa.String(32), unique=True, nullable=False),
        sa.Column("issued_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("delivered_at", sa.Integer()),
        sa.Column("result_ok", sa.Boolean()),
        sa.Column("result_state", sa.String(24)),
        sa.Column("error", sa.String(160)))
    op.create_index("ix_device_commands_target_device_id", "device_commands", ["target_device_id"])


def downgrade() -> None:
    op.drop_table("device_commands")
    op.drop_table("heartbeats")
    op.drop_table("used_refresh_tokens")
    op.drop_table("device_sessions")
    op.drop_table("enrollment_sessions")
