.PHONY: copy clean all

all: ./submodules/nginx/objs/nginz.c

./submodules/nginx/objs/ngx_modules.c:
	cd submodules/nginx && ./auto/configure \
		--with-compat \
		--with-file-aio \
		--with-threads \
		--with-http_ssl_module \
		--with-http_xslt_module \
		--with-http_v2_module \
		--with-http_v3_module \
		--with-stream \
		--with-stream_realip_module \
		--with-stream_ssl_module \
		--with-stream_ssl_preread_module \
		--with-debug
	cd submodules/njs && ./configure

copy: ./submodules/nginx/objs/nginz.c

./submodules/nginx/objs/nginz.c: ./submodules/nginx/src/core/nginx.c ./submodules/nginx/objs/ngx_modules.c project/nginz.patch project/nginz.makefile
	@set -e; tmp=$$(mktemp "$@.XXXXXX"); \
	trap 'rm -f "$$tmp"' EXIT HUP INT TERM; \
	cp -p "$<" "$$tmp"; \
	patch --silent --batch -N "$$tmp" < project/nginz.patch; \
	if ! cmp -s "$$tmp" "$@"; then mv "$$tmp" "$@"; fi

clean:
	rm -f ./submodules/nginx/objs/ngx_modules.c ./submodules/nginx/objs/nginz.c
