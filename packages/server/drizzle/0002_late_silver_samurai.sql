CREATE TABLE "workbench_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "kind" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "workbench_sessions" ADD CONSTRAINT "workbench_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workbench_sessions_device_idx" ON "workbench_sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "workbench_sessions_expires_idx" ON "workbench_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_kind_check" CHECK ("devices"."kind" in ('full', 'temporary'));