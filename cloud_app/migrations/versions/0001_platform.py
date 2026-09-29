"""Initial Cloud platform tables.

Revision ID: 0001_platform
Revises:
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_platform"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(80), unique=True, nullable=False),
        sa.Column("password_hash", sa.String(200), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("revoked_at", sa.Integer()))
    op.create_table("devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_type", sa.String(16), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("protocol_version", sa.String(16), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("last_seen_at", sa.Integer()),
        sa.Column("revoked_at", sa.Integer()),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.Column("legacy_gateway_id", sa.String(64)))
    op.create_index("ix_devices_owner_id", "devices", ["owner_id"])
    op.create_index("ix_devices_device_type", "devices", ["device_type"])
    op.create_table("device_links",
        sa.Column("gateway_id", sa.String(36), sa.ForeignKey("devices.id"), primary_key=True),
        sa.Column("windows_id", sa.String(36), sa.ForeignKey("devices.id"), primary_key=True),
        sa.Column("relationship", sa.String(24), primary_key=True),
        sa.Column("created_at", sa.Integer(), nullable=False))
    op.create_table("web_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("csrf_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False))
    op.create_index("ix_web_sessions_owner_id", "web_sessions", ["owner_id"])
    op.create_index("ix_web_sessions_expires_at", "web_sessions", ["expires_at"])
    op.create_table("legacy_clients",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("credential_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False))
    op.create_index("ix_legacy_clients_owner_id", "legacy_clients", ["owner_id"])
    op.create_table("platform_commands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("target_device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("route", sa.String(24), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("issued_at", sa.Integer(), nullable=False),
        sa.Column("completed_at", sa.Integer()),
        sa.Column("error", sa.String(160), nullable=False))
    op.create_index("ix_platform_commands_owner_id", "platform_commands", ["owner_id"])
    op.create_index("ix_platform_commands_target_device_id", "platform_commands", ["target_device_id"])
    op.create_table("audit_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("event", sa.String(40), nullable=False),
        sa.Column("target_device_id", sa.String(36)),
        sa.Column("route", sa.String(24)),
        sa.Column("created_at", sa.Integer(), nullable=False))
    op.create_index("ix_audit_logs_owner_id", "audit_logs", ["owner_id"])


def downgrade() -> None:
    op.drop_table("audit_logs")
    op.drop_table("platform_commands")
    op.drop_table("legacy_clients")
    op.drop_table("web_sessions")
    op.drop_table("device_links")
    op.drop_table("devices")
    op.drop_table("users")
