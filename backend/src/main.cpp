// msentity-viewer-backend: serves the viewer UI over stdin/stdout.
//
//   msentity-viewer-backend dataset <file> [--page-size N] [--file-type msds|msp|mgf|tsv|csv]
//   msentity-viewer-backend similarity <file.mssim> [--page-size N]
//   msentity-viewer-backend --version
//
// Requests are JSON objects, one per line, on stdin. Responses are lines on
// stdout starting with "MSENTITY_JSON:"; diagnostics go to stderr.
// The protocol is described in docs/protocol.md.

#include <iostream>
#include <optional>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

#include "backends.hpp"

namespace {

int usage() {
  std::cerr << "usage:\n"
               "  msentity-viewer-backend dataset <file> [options]\n"
               "    --page-size N --file-type T --spec-id-prefix P --infer-types\n"
               "    --allow-duplicate-cols --canonicalize-column\n"
               "    --canonicalize-adduct-type --normalize-intensity\n"
               "    --error-log-level none|basic|detail --error-log-file PATH\n"
               "    --error-context-lines N\n"
               "  msentity-viewer-backend similarity <file.mssim> [--page-size N]\n"
               "  msentity-viewer-backend --version\n";
  return 2;
}

int run(const std::vector<std::string>& args) {
  if (args.size() == 1 && args[0] == "--version") {
    std::cout << MSENTITY_VIEWER_VERSION << "\n";
    return 0;
  }
  if (args.size() < 2) return usage();
  const std::string& mode = args[0];
  std::string path = args[1];
  std::optional<int> page_size;
  std::optional<std::string> file_type;
  viewer::DatasetLoadOptions load_options;
  for (std::size_t i = 2; i < args.size(); ++i) {
    if (args[i] == "--page-size" && i + 1 < args.size()) {
      try {
        page_size = std::stoi(args[++i]);
      } catch (const std::exception&) {
        return usage();
      }
    } else if (args[i] == "--file-type" && i + 1 < args.size()) {
      file_type = args[++i];
    } else if (args[i] == "--spec-id-prefix" && i + 1 < args.size()) {
      load_options.spec_id_prefix = args[++i];
    } else if (args[i] == "--infer-types") {
      load_options.infer_types = true;
    } else if (args[i] == "--allow-duplicate-cols") {
      load_options.allow_duplicate_cols = true;
    } else if (args[i] == "--canonicalize-column") {
      load_options.canonicalize_column = true;
    } else if (args[i] == "--no-canonicalize-column") {
      load_options.canonicalize_column = false;
    } else if (args[i] == "--canonicalize-adduct-type") {
      load_options.canonicalize_adduct_type = true;
    } else if (args[i] == "--no-canonicalize-adduct-type") {
      load_options.canonicalize_adduct_type = false;
    } else if (args[i] == "--normalize-intensity") {
      load_options.normalize_intensity = true;
    } else if (args[i] == "--no-normalize-intensity") {
      load_options.normalize_intensity = false;
    } else if (args[i] == "--error-log-level" && i + 1 < args.size()) {
      load_options.error_log_level = args[++i];
      if (load_options.error_log_level != "none" && load_options.error_log_level != "basic" &&
          load_options.error_log_level != "detail") return usage();
    } else if (args[i] == "--error-log-file" && i + 1 < args.size()) {
      load_options.error_log_file = args[++i];
    } else if (args[i] == "--error-context-lines" && i + 1 < args.size()) {
      try {
        load_options.error_context_lines = std::stoi(args[++i]);
        if (load_options.error_context_lines < 0) return usage();
      } catch (const std::exception&) {
        return usage();
      }
    } else {
      return usage();
    }
  }
  if (mode == "dataset")
    return viewer::run_dataset_backend(path, page_size.value_or(20), file_type, load_options);
  if (mode == "similarity") return viewer::run_similarity_backend(path, page_size.value_or(50));
  return usage();
}

}  // namespace

#if defined(_WIN32)
// Arguments as UTF-8; stdin/stdout without newline translation.
int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  std::vector<std::string> args;
  for (int i = 1; i < argc; ++i) {
    int size = WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, nullptr, 0, nullptr, nullptr);
    std::string text(static_cast<std::size_t>(size > 0 ? size - 1 : 0), '\0');
    WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, text.data(), size, nullptr, nullptr);
    args.push_back(text);
  }
  return run(args);
}
#else
int main(int argc, char** argv) { return run(std::vector<std::string>(argv + 1, argv + argc)); }
#endif
