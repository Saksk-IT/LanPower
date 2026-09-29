"""Device initiated enrollment with administrator approval.

Revision ID: 0004_device_authorization
Revises: 0003_unified_identity
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_device_authorization"
down_revision = "0003_unified_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("device_authorizations",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("user_code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id")),
        sa.Column("device_type", sa.String(16), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("next_poll_at", sa.Integer(), nullable=False),
        sa.Column("approved_at", sa.Integer()),
        sa.Column("denied_at", sa.Integer()),
        sa.Column("redeemed_at", sa.Integer()))
    op.create_index("ix_device_authorizations_expires_at", "device_authorizations", ["expires_at"])


def downgrade() -> None:
    op.drop_table("device_authorizations")
