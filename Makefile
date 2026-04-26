IMAGE_NAME ?= myclaw:local
CONTAINER_NAME ?= myclaw-app
HOST_PORT ?= 3213
CONTAINER_PORT ?= 3000
ENV_FILE_ARGS := $(if $(wildcard .env),--env-file .env,)

.PHONY: build install image start stop restart clean

build: node_modules
	npm run build

install node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

image:
	docker build -t $(IMAGE_NAME) .

start: image
	@if docker ps -aq -f name=^/$(CONTAINER_NAME)$$ | grep -q .; then \
		echo "Container $(CONTAINER_NAME) already exists. Run 'make restart' or 'make stop' first."; \
		exit 1; \
	fi
	docker run -d --name $(CONTAINER_NAME) -p $(HOST_PORT):$(CONTAINER_PORT) $(ENV_FILE_ARGS) $(IMAGE_NAME)

stop:
	@if docker ps -aq -f name=^/$(CONTAINER_NAME)$$ | grep -q .; then \
		docker stop $(CONTAINER_NAME) >/dev/null; \
		docker rm $(CONTAINER_NAME) >/dev/null; \
		echo "Stopped and removed $(CONTAINER_NAME)"; \
	else \
		echo "Container $(CONTAINER_NAME) does not exist."; \
	fi

restart: stop start

clean:
	rm -rf dist
