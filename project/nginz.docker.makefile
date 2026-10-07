.PHONY: copy clean all

all: ./submodules/nginx/objs/nginz.c

./submodules/nginx/objs/ngx_modules.c:
	cd submodules/nginx && ./auto/configure \
		--prefix=/etc/nginx \
		--sbin-path=/usr/sbin/nginx \
		--modules-path=/usr/lib/nginx/modules \
		--conf-path=/etc/nginx/nginx.conf \
		--error-log-path=/var/log/nginx/error.log \
		--pid-path=/var/run/nginx.pid \
		--lock-path=/var/run/nginx.lock \
		--http-log-path=/var/log/nginx/access.log \
		--http-client-body-temp-path=/var/cache/nginx/client_temp \
		--http-proxy-temp-path=/var/cache/nginx/proxy_temp \
		--http-fastcgi-temp-path=/var/cache/nginx/fastcgi_temp \
		--http-uwsgi-temp-path=/var/cache/nginx/uwsgi_temp \
		--http-scgi-temp-path=/var/cache/nginx/scgi_temp \
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
		--with-stream_ssl_preread_module
	cd submodules/njs && ./configure

copy: ./submodules/nginx/objs/nginz.c

./submodules/nginx/objs/nginz.c: ./submodules/nginx/src/core/nginx.c ./submodules/nginx/objs/ngx_modules.c project/nginz.patch project/nginz.docker.makefile
	@set -e; tmp=$$(mktemp "$@.XXXXXX"); \
	trap 'rm -f "$$tmp"' EXIT HUP INT TERM; \
	cp -p "$<" "$$tmp"; \
	patch --silent --batch -N "$$tmp" < project/nginz.patch; \
	if ! cmp -s "$$tmp" "$@"; then mv "$$tmp" "$@"; fi

clean:
	rm -f ./submodules/nginx/objs/ngx_modules.c ./submodules/nginx/objs/nginz.c
