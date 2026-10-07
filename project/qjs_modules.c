/* Core modules only: nginx supplies the optional engine addons. */
#include <qjs.h>

extern qjs_module_t qjs_buffer_module;
extern qjs_module_t qjs_fs_module;
extern qjs_module_t qjs_query_string_module;

qjs_module_t *qjs_modules[] = {
    &qjs_buffer_module,
    &qjs_fs_module,
    &qjs_query_string_module,
    NULL
};
