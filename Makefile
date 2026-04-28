IMAGE_NAME ?= myclaw:local
CONTAINER_NAME ?= myclaw-app
HOST_PORT ?= 3213
CONTAINER_PORT ?= 3000
ENV_FILE_ARGS := $(if $(wildcard .env),--env-file .env,)

.PHONY: build install image start assistant staff stop restart clean

build: node_modules
	npm run build

install node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

image:
	docker build -t $(IMAGE_NAME) .

assistant: PROFILE := assistant
assistant: restart

staff: PROFILE := staff
staff: restart

start: image
	@if [ -z "$(PROFILE)" ]; then \
		echo "Choose a profile target: make assistant or make staff"; \
		exit 1; \
	fi
	@if [ "$(PROFILE)" != "assistant" ] && [ "$(PROFILE)" != "staff" ]; then \
		echo "PROFILE must be assistant or staff."; \
		exit 1; \
	fi
	@if docker ps -aq -f name=^/$(CONTAINER_NAME)$$ | grep -q .; then \
		echo "Container $(CONTAINER_NAME) already exists. Run 'make assistant' or 'make staff' to restart with a profile, or 'make stop' first."; \
		exit 1; \
	fi
	docker run -d --name $(CONTAINER_NAME) -p $(HOST_PORT):$(CONTAINER_PORT) $(ENV_FILE_ARGS) $(IMAGE_NAME) --profile $(PROFILE)

stop:
	@if docker ps -aq -f name=^/$(CONTAINER_NAME)$$ | grep -q .; then \
		docker stop $(CONTAINER_NAME) >/dev/null; \
		docker rm $(CONTAINER_NAME) >/dev/null; \
		echo "Stopped and removed $(CONTAINER_NAME)"; \
	else \
		echo "Container $(CONTAINER_NAME) does not exist."; \
	fi

restart:
	@if [ -z "$(PROFILE)" ]; then \
		echo "Choose a profile target: make assistant or make staff"; \
		exit 1; \
	fi
	@$(MAKE) stop
	@$(MAKE) start PROFILE=$(PROFILE)

clean:
	rm -rf dist
