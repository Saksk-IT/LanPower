"""Schedules, offline notifications and mobile action scopes (v1.7)."""
from alembic import op
import sqlalchemy as sa

revision = "0009_automation"
down_revision = "0008_persistent_clients"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("client_sessions", "client_enrollments"):
        op.add_column(table, sa.Column("allowed_actions", sa.String(100), nullable=False, server_default=""))
    op.create_table(
        "scheduled_tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("hour", sa.Integer(), nullable=False),
        sa.Column("minute", sa.Integer(), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("label", sa.String(100), nullable=False),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("last_run_at", sa.Integer(), nullable=True),
        sa.Column("next_run_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("hour BETWEEN 0 AND 23", name="ck_schedule_hour"),
        sa.CheckConstraint("minute BETWEEN 0 AND 59", name="ck_schedule_minute"),
        sa.CheckConstraint("weekday BETWEEN -1 AND 6", name="ck_schedule_weekday"),
        sa.CheckConstraint("action IN ('sleep','hibernate','restart','shutdown','wake')", name="ck_schedule_action"),
    )
    op.create_index("ix_scheduled_tasks_owner_id", "scheduled_tasks", ["owner_id"])
    op.create_index("ix_scheduled_tasks_device_id", "scheduled_tasks", ["device_id"])
    op.create_index("ix_scheduled_tasks_due", "scheduled_tasks", ["enabled", "next_run_at"])
    op.create_table(
        "notification_configs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("openid", sa.String(128), nullable=False),
        sa.Column("template_id", sa.String(128), nullable=False),
        sa.Column("offline_minutes", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("last_sent_at", sa.Integer(), nullable=True),
        sa.CheckConstraint("offline_minutes BETWEEN 1 AND 10080", name="ck_notification_threshold"),
    )
    op.create_index("ix_notification_configs_owner_id", "notification_configs", ["owner_id"])
    op.create_index("ix_notification_configs_device_id", "notification_configs", ["device_id"])


def downgrade() -> None:
    op.drop_table("notification_configs")
    op.drop_table("scheduled_tasks")
    for table in ("client_enrollments", "client_sessions"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("allowed_actions")
