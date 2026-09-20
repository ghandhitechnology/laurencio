CREATE TABLE "vault_heads" (
	"store_id" text PRIMARY KEY NOT NULL,
	"blob_id" text NOT NULL,
	"blob_size" bigint NOT NULL,
	"generation" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_heads" ADD CONSTRAINT "vault_heads_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;