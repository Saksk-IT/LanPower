"""Passkey, recovery and one-use browser ceremony state.

Revision ID: 0003_unified_identity
Revises: 0002_windows_direct
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_unified_identity"
down_revision = "0002_windows_direct"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("identity_initialized_at", sa.Integer()))
    op.create_table("passkeys",
        sa.Column("credential_id", sa.String(2048), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("public_key", sa.String(2048), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("last_used_at", sa.Integer()),
        sa.Column("backed_up", sa.Boolean(), nullable=False))
    op.create_index("ix_passkeys_owner_id", "passkeys", ["owner_id"])
    op.create_table("recovery_codes",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("used_at", sa.Integer()))
    op.create_index("ix_recovery_codes_owner_id", "recovery_codes", ["owner_id"])
    op.create_table("auth_challenges",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("challenge", sa.String(128), nullable=False),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("binding_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("used_at", sa.Integer()))
    op.create_index("ix_auth_challenges_owner_id", "auth_challenges", ["owner_id"])


def downgrade() -> None:
    op.drop_table("auth_challenges")
    op.drop_table("recovery_codes")
    op.drop_table("passkeys")
    op.drop_column("users", "identity_initialized_at")
