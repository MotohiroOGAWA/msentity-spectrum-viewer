#pragma once

#include <optional>
#include <string>

namespace viewer {

struct DatasetLoadOptions {
  bool canonicalize_column = false;
  bool canonicalize_adduct_type = false;
  bool normalize_intensity = false;
  bool allow_duplicate_cols = false;
  std::optional<std::string> spec_id_prefix;
  bool infer_types = false;
  std::string error_log_level = "none";
  std::optional<std::string> error_log_file;
  int error_context_lines = 10;
};

// Serve requests for a dataset viewer opened on `path` (protocol: docs/protocol.md).
int run_dataset_backend(const std::string& path, int page_size,
                        const std::optional<std::string>& file_type,
                        const DatasetLoadOptions& load_options = {});

// Serve requests for a similarity result viewer opened on an .mssim file.
int run_similarity_backend(const std::string& path, int page_size);

}  // namespace viewer
