CREATE TABLE "user_wallet_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_usdc_transfer_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_wallet_settings" ADD CONSTRAINT "user_wallet_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
