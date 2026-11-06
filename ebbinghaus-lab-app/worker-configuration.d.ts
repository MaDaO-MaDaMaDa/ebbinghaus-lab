// Cloudflare Worker Environment Bindings

interface Env {
	DB: D1Database;
	JWT_SECRET: string;
	ALLOWED_ORIGINS?: string;
}
