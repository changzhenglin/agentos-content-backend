CREATE TABLE "ingest" (
	"id" text PRIMARY KEY NOT NULL,
	"track_id" text NOT NULL,
	"source" text NOT NULL,
	"raw_metadata" text NOT NULL,
	"audio_object_key" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lyrics" (
	"track_id" text,
	"line_index" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"text" text NOT NULL,
	"lyrics_license" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" text PRIMARY KEY NOT NULL,
	"ingest_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"track_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album" text,
	"duration_ms" integer NOT NULL,
	"cover_url" text,
	"audio_object_key" text NOT NULL,
	"format" text NOT NULL,
	"bitrate" integer NOT NULL,
	"isrc" text,
	"license" text NOT NULL,
	"region_policy" text,
	"published_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lyrics" ADD CONSTRAINT "lyrics_track_id_tracks_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("track_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lyrics_pk" ON "lyrics" USING btree ("track_id","line_index");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_isrc_uk" ON "tracks" USING btree ("isrc");