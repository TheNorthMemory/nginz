/* Core modules only: nginx supplies the optional engine addons. */
#include <njs_main.h>

extern njs_module_t njs_buffer_module;
extern njs_module_t njs_fs_module;
extern njs_module_t njs_query_string_module;

njs_module_t *njs_modules[] = {
    &njs_buffer_module,
    &njs_fs_module,
    &njs_query_string_module,
    NULL
};
