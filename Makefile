SHELL := /bin/zsh

ROOT := $(CURDIR)
ENV_FILE := $(ROOT)/.env
BACKEND_MANIFEST := $(ROOT)/backend/Cargo.toml
FRONTEND_DIR := $(ROOT)/frontend
DEFAULT_API_PROXY := http://127.0.0.1:3000
RUN_DIR := $(ROOT)/.run
BACKEND_PID_FILE := $(RUN_DIR)/backend.pid
FRONTEND_PID_FILE := $(RUN_DIR)/frontend.pid

.PHONY: dev dev-db dev-backend dev-frontend stop stop-db

dev:
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
		echo "Missing $(ENV_FILE). Copy .env.example to .env and fill in the OAuth credentials."; \
		exit 1; \
	fi; \
	mkdir -p "$(RUN_DIR)"; \
	$(MAKE) --no-print-directory stop >/dev/null 2>&1 || true; \
	set -a; \
	source "$(ENV_FILE)"; \
	set +a; \
	backend_pid=""; \
	frontend_pid=""; \
	trap 'exit_code=$$?; \
		if [[ -n "$$frontend_pid" ]]; then \
			kill "$$frontend_pid" 2>/dev/null || true; \
			wait "$$frontend_pid" 2>/dev/null || true; \
		fi; \
		if [[ -n "$$backend_pid" ]]; then \
			kill "$$backend_pid" 2>/dev/null || true; \
			wait "$$backend_pid" 2>/dev/null || true; \
		fi; \
		rm -f "$(BACKEND_PID_FILE)" "$(FRONTEND_PID_FILE)"; \
		exit $$exit_code' EXIT INT TERM; \
	cargo run --manifest-path "$(BACKEND_MANIFEST)" & \
	backend_pid=$$!; \
	echo "$$backend_pid" > "$(BACKEND_PID_FILE)"; \
	VITE_API_PROXY_TARGET="$${VITE_API_PROXY_TARGET:-$(DEFAULT_API_PROXY)}" \
		corepack pnpm --dir "$(FRONTEND_DIR)" dev & \
	frontend_pid=$$!; \
	echo "$$frontend_pid" > "$(FRONTEND_PID_FILE)"; \
	wait $$backend_pid $$frontend_pid

dev-db:
	@echo "Postgres is managed outside this Makefile. Start it locally before running make dev."

dev-backend:
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
		echo "Missing $(ENV_FILE). Copy .env.example to .env and fill in the OAuth credentials."; \
		exit 1; \
	fi; \
	set -a; \
	source "$(ENV_FILE)"; \
	set +a; \
	cargo run --manifest-path "$(BACKEND_MANIFEST)"

dev-frontend:
	@if [[ ! -f "$(ENV_FILE)" ]]; then \
		echo "Missing $(ENV_FILE). Copy .env.example to .env and fill in the OAuth credentials."; \
		exit 1; \
	fi; \
	set -a; \
	source "$(ENV_FILE)"; \
	set +a; \
	VITE_API_PROXY_TARGET="$${VITE_API_PROXY_TARGET:-$(DEFAULT_API_PROXY)}" \
		corepack pnpm --dir "$(FRONTEND_DIR)" dev

stop:
	@mkdir -p "$(RUN_DIR)"; \
	current_pid=$$$$; \
	current_ppid=$$PPID; \
	stop_pid() { \
		local pid="$$1"; \
		if [[ -z "$$pid" ]] || ! kill -0 "$$pid" 2>/dev/null; then \
			return; \
		fi; \
		kill "$$pid" 2>/dev/null || true; \
		for _ in 1 2 3 4 5; do \
			kill -0 "$$pid" 2>/dev/null || return; \
			sleep 1; \
		done; \
		kill -9 "$$pid" 2>/dev/null || true; \
	}; \
	stop_pid_file() { \
		local pid_file="$$1"; \
		if [[ -f "$$pid_file" ]]; then \
			local pid="$$(cat "$$pid_file" 2>/dev/null)"; \
			stop_pid "$$pid"; \
			rm -f "$$pid_file"; \
		fi; \
	}; \
	stop_pid_file "$(FRONTEND_PID_FILE)"; \
	stop_pid_file "$(BACKEND_PID_FILE)"; \
	while read -r pid cmd; do \
		[[ -n "$$pid" ]] || continue; \
		[[ "$$pid" == "$$current_pid" || "$$pid" == "$$current_ppid" ]] && continue; \
		case "$$cmd" in \
			*"$(ROOT)/backend/target/debug/backend"*|*"cargo run --manifest-path $(BACKEND_MANIFEST)"*|*"corepack pnpm --dir $(FRONTEND_DIR) dev"*|*"$(FRONTEND_DIR)/node_modules/.bin/../vite-plus/bin/vp dev"*|*"$(FRONTEND_DIR)/node_modules/.pnpm/"*"@voidzero-dev+vite-plus-core"*"/dist/vite/node/cli.js dev"*) \
				stop_pid "$$pid" ;; \
		esac; \
	done < <(ps -axo pid=,command=); \
	for port in 3000 5173 5174 5175 5176 5177; do \
		while IFS= read -r pid; do \
			[[ -n "$$pid" ]] || continue; \
			[[ "$$pid" == "$$current_pid" || "$$pid" == "$$current_ppid" ]] && continue; \
			cmd="$$(ps -p "$$pid" -o command= 2>/dev/null || true)"; \
			case "$$cmd" in \
				*"$(ROOT)/backend/target/debug/backend"*|*"$(FRONTEND_DIR)"*"vite-plus"*|*"corepack pnpm --dir $(FRONTEND_DIR) dev"*) \
					stop_pid "$$pid" ;; \
			esac; \
		done < <(lsof -ti tcp:$$port -sTCP:LISTEN 2>/dev/null || true); \
	done

stop-db:
	@echo "Postgres is managed outside this Makefile."
