CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(127) NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_driver" varchar(16) NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "voice_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"livekit_room_name" varchar(200) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"access_mode" varchar(16) DEFAULT 'members' NOT NULL,
	"proximity_enabled" boolean DEFAULT false NOT NULL,
	"proximity_radius" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_rooms" ADD CONSTRAINT "voice_rooms_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachments_channel" ON "attachments" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_uploader" ON "attachments" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_created" ON "attachments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_rooms_channel_unique" ON "voice_rooms" USING btree ("channel_id");
