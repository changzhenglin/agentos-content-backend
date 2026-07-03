CREATE TABLE "content_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"action" text NOT NULL,
	"target_scope" text NOT NULL,
	"version" integer NOT NULL,
	"envelope" text NOT NULL,
	"caller_identity" text NOT NULL,
	"command_id" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"superseded_by" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_policy_cmd_uk" ON "content_policy" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_policy_rule_ver_uk" ON "content_policy" USING btree ("rule_id","version");