// Similarity result viewer backend: pages, histogram, statistics, matched
// spectra, the peak intensity coverage plot, and export of a filtered .mssim result.

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <numeric>
#include <random>

#include <msentity/similarity/similarity.hpp>

#include "backends.hpp"
#include "json_support.hpp"
#include "view.hpp"

namespace viewer {

namespace fs = std::filesystem;
namespace sim = msentity::similarity;

namespace {

std::string utf8(const fs::path& path) {
  auto text = path.u8string();
  return std::string(text.begin(), text.end());
}

fs::path from_utf8(const std::string& text) {
  return fs::path(std::u8string(text.begin(), text.end()));
}

json finite(double value) { return std::isfinite(value) ? json(value) : json(nullptr); }

// A number of a result cell, or NaN for a missing or non-numeric value.
double numeric(const Value& value) {
  if (const auto* d = std::get_if<double>(&value)) return *d;
  if (const auto* i = std::get_if<int64_t>(&value)) return static_cast<double>(*i);
  return std::nan("");
}

// [low, high] of an axis from request[name] ([low, high]; default [0, 1]).
std::pair<double, double> axis_range(const json& request, const char* name) {
  json value = request.value(name, json::array({0.0, 1.0}));
  if (!value.is_array() || value.size() != 2 || !value[0].is_number() || !value[1].is_number()) {
    throw std::invalid_argument(std::string(name) + " must be [minimum, maximum]");
  }
  double low = value[0].get<double>(), high = value[1].get<double>();
  if (!std::isfinite(low) || !std::isfinite(high) || !(high > low)) {
    throw std::invalid_argument(std::string(name) + ": the maximum must be greater than the minimum");
  }
  return {low, high};
}

int bin_count(const json& request, const char* name, int fallback) {
  int bins = request.value(name, json(fallback)).get<int>();
  if (bins < 1 || bins > 500) throw std::invalid_argument(std::string(name) + " must be between 1 and 500");
  return bins;
}

// Gaussian kernel density of values in [0, 1], evaluated at `points` evenly
// spaced positions from 0 to 1. Values are first binned (1024 bins), and the
// bandwidth follows Scott's rule (sd · n^(-1/5)), as seaborn's kdeplot does.
json kernel_density(const std::vector<double>& values, int points = 201) {
  json grid = json::array(), density = json::array();
  const int n = static_cast<int>(values.size());
  constexpr int kBins = 1024;
  std::vector<double> counts(kBins, 0.0);
  double mean = 0.0;
  for (double v : values) mean += v;
  mean = n ? mean / n : 0.0;
  double variance = 0.0;
  for (double v : values) {
    variance += (v - mean) * (v - mean);
    int bin = static_cast<int>(std::clamp(v, 0.0, 1.0) * kBins);
    counts[static_cast<std::size_t>(std::min(bin, kBins - 1))] += 1.0;
  }
  double sd = n > 1 ? std::sqrt(variance / (n - 1)) : 0.0;
  double h = sd > 0 ? sd * std::pow(static_cast<double>(n), -0.2) : 0.01;
  h = std::max(h, 1.0 / kBins);
  const double norm = 1.0 / (std::max(1, n) * h * 2.5066282746310002);  // sqrt(2 pi)
  for (int g = 0; g < points; ++g) {
    double x = static_cast<double>(g) / (points - 1);
    double sum = 0.0;
    for (int b = 0; b < kBins; ++b) {
      if (counts[static_cast<std::size_t>(b)] == 0.0) continue;
      double z = (x - (b + 0.5) / kBins) / h;
      if (z > 8.0 || z < -8.0) continue;
      sum += counts[static_cast<std::size_t>(b)] * std::exp(-0.5 * z * z);
    }
    grid.push_back(x);
    density.push_back(n ? sum * norm : 0.0);
  }
  return {{"grid", grid}, {"density", density}};
}

class SimilarityBackend {
 public:
  SimilarityBackend(std::string path, int page_size) : path_(std::move(path)), page_size_(page_size) {}

  int run() {
    try {
      load();
    } catch (const std::exception& error) {
      emit({{"type", "error"}, {"message", error.what()}});
      return 1;
    }
    emit({{"type", "backend-ready"}});
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.find_first_not_of(" \t") == std::string::npos) continue;
      try {
        json request = json::parse(line);
        std::string kind = json_text(request.value("type", json()));
        if (kind == "reload") load();
        if (kind == "page" || kind == "reload") {
          emit({{"type", "similarity-page"}, {"value", page(request)}});
        } else if (kind == "coverage") {
          json payload = coverage(request);
          emit({{"type", "similarity-coverage"}, {"value", payload}});
        } else if (kind == "match") {
          json payload = match(request.at("row").get<int64_t>(), request.value("score", json("")));
          payload["type"] = "similarity-match";
          emit(payload);
        } else if (kind == "export") {
          int64_t count = export_result(request);
          emit({{"type", "export-complete"}, {"path", request.at("path")}, {"total_rows", count}});
        } else {
          throw std::invalid_argument("Unknown request: " + kind);
        }
      } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        emit({{"type", "error"}, {"message", error.what()}});
      }
    }
    return 0;
  }

 private:
  std::string path_;
  int page_size_;
  std::optional<sim::SimilarityDataset> result_;
  json metadata_;

  void load() {
    result_ = sim::SimilarityDataset::load(path_);
    metadata_ = json::parse(result_->metadata_json());
  }

  std::vector<int64_t> rows(const json& request) const {
    const auto& result = *result_;
    return table_view_rows(
        result.size(), result.columns(),
        [&](const std::string& column) { return result.column_values(column); },
        request.value("filters", json::array()), request.value("sort", json()));
  }

  // The rows of the result in view order, as a SimilarityDataset (for export).
  sim::SimilarityDataset view_of(const std::vector<int64_t>& order) const {
    const auto& result = *result_;
    std::vector<bool> keep(static_cast<std::size_t>(result.size()), false);
    for (int64_t row : order) keep[static_cast<std::size_t>(row)] = true;
    if (std::is_sorted(order.begin(), order.end())) return result.filter(keep);
    // filter() keeps table order: add each row's rank in the view as a
    // temporary column, filter, sort by it, and drop it.
    std::vector<int64_t> rank(static_cast<std::size_t>(result.size()), 0);
    for (std::size_t i = 0; i < order.size(); ++i) {
      rank[static_cast<std::size_t>(order[i])] = static_cast<int64_t>(i);
    }
    arrow::Int64Builder builder;
    if (!builder.AppendValues(rank).ok()) throw std::runtime_error("cannot build view order");
    auto table = result.table();
    auto with_rank = table->AddColumn(table->num_columns(), arrow::field("__view_rank", arrow::int64()),
                                      std::make_shared<arrow::ChunkedArray>(builder.Finish().ValueOrDie()))
                         .ValueOrDie();
    sim::SimilarityDataset ranked(with_rank, result.metadata_json(), result.matched_datasets(),
                                  result.matched_source_indices());
    sim::SimilarityDataset ordered = ranked.filter(keep).sort_by({"__view_rank"}, {true});
    auto ordered_table = ordered.table();
    auto clean = ordered_table->RemoveColumn(ordered_table->schema()->GetFieldIndex("__view_rank")).ValueOrDie();
    return sim::SimilarityDataset(clean, ordered.metadata_json(), ordered.matched_datasets(),
                                  ordered.matched_source_indices());
  }

  // The score column of a request ("score"; default the first score column).
  std::string score_of(const json& request) const {
    auto names = result_->score_columns();
    std::string score = request.contains("score") ? json_text(request["score"]) : "";
    if (score.empty()) return names.front();
    if (std::find(names.begin(), names.end(), score) == names.end()) {
      throw std::invalid_argument("Not a score column of this result: " + score);
    }
    return score;
  }

  json page(const json& request) const {
    const auto& result = *result_;
    const std::string score = score_of(request);
    std::vector<int64_t> order = rows(request);
    int bins = request.value("bins", json(20)).get<int>();
    if (bins < 1 || bins > 200) throw std::invalid_argument("Histogram bins must be between 1 and 200");

    // Statistics and histogram of the filtered rows.
    std::vector<bool> keep(static_cast<std::size_t>(result.size()), false);
    for (int64_t row : order) keep[static_cast<std::size_t>(row)] = true;
    sim::SimilarityDataset filtered = result.filter(keep);
    auto histogram = filtered.histogram(bins, score);
    auto summary = filtered.describe_scores(score);

    int64_t total = static_cast<int64_t>(order.size());
    int64_t pages = std::max<int64_t>(1, (total + page_size_ - 1) / page_size_);
    int64_t page = std::min(std::max<int64_t>(0, request.value("page", json(0)).get<int64_t>()), pages - 1);
    int64_t start = page * page_size_;
    int64_t stop = std::min(start + page_size_, total);

    const auto columns = result.columns();
    std::vector<std::vector<Value>> values;
    for (const auto& column : columns) values.push_back(result.column_values(column));
    json page_rows = json::array();
    json indices = json::array();
    for (int64_t i = start; i < stop; ++i) {
      int64_t row = order[static_cast<std::size_t>(i)];
      json item = json::object();
      for (std::size_t c = 0; c < columns.size(); ++c) {
        item[columns[c]] = to_json(values[c][static_cast<std::size_t>(row)]);
      }
      page_rows.push_back(std::move(item));
      indices.push_back(row);
    }
    json edges = json::array();
    for (double edge : histogram.edges) edges.push_back(finite(edge));
    // Every score column, for comparing methods (same bins, filtered rows).
    auto statistics_json = [](const sim::ScoreSummary& s) {
      return json{{"count", s.count}, {"mean", finite(s.mean)}, {"q1", finite(s.q1)},
                  {"median", finite(s.median)}, {"q3", finite(s.q3)},
                  {"min", finite(s.min)}, {"max", finite(s.max)}};
    };
    json histograms = json::object(), statistics_by_score = json::object();
    for (const auto& column : result.score_columns()) {
      histograms[column] = filtered.histogram(bins, column).counts;
      statistics_by_score[column] = statistics_json(filtered.describe_scores(column));
    }
    json matched_rows = json::array({0, 0});
    if (result.has_matched_data()) {
      matched_rows = {result.matched_datasets()->first.size(), result.matched_datasets()->second.size()};
    }
    return {{"columns", columns},
            {"rows", page_rows},
            {"result_indices", indices},
            {"page", page},
            {"total_pages", pages},
            {"page_size", page_size_},
            {"total_rows", total},
            {"unfiltered_rows", result.size()},
            {"metadata", metadata_},
            {"has_matched_data", result.has_matched_data()},
            {"matched_data_rows", matched_rows},
            {"score_columns", result.score_columns()},
            {"score", score},
            {"scored_rows", summary.count},   // filtered rows with a value in the score column
            {"histogram", {{"counts", histogram.counts}, {"edges", edges}}},
            {"histograms", histograms},                   // counts per score column, same edges
            {"statistics_by_score", statistics_by_score},
            {"statistics", {{"mean", finite(summary.mean)}, {"q1", finite(summary.q1)},
                            {"median", finite(summary.median)}, {"q3", finite(summary.q3)},
                            {"min", finite(summary.min)}, {"max", finite(summary.max)}}}};
  }

  // Peak intensity coverage (x) against similarity (y) of the filtered rows: a 2D
  // histogram over x_range × y_range (x_bins × y_bins cells, rows from the
  // bottom; the last bin of each axis includes its maximum), up to max_points
  // points (a fixed-seed random sample when there are more rows), and the
  // kernel density of each axis over [0, 1].
  json coverage(const json& request) const {
    const auto& result = *result_;
    int side = request.value("side", json(1)).get<int>();
    if (side != 1 && side != 2) throw std::invalid_argument("side must be 1 or 2");
    const std::string score = score_of(request);
    const auto columns = result.columns();
    const auto has = [&](const std::string& name) {
      return std::find(columns.begin(), columns.end(), name) != columns.end();
    };
    // Modified cosine and BONANZA are plotted against the coverage of their
    // own pairing (direct and precursor-shifted peaks; it bounds modified
    // cosine), when the result has that column.
    std::string column = "peak_intensity_coverage" + std::to_string(side);
    if ((score == "modified_cosine" || score == "bonanza") && has("modified_" + column)) column = "modified_" + column;
    if (!has(column)) {
      throw std::invalid_argument(
          "This result has no peak intensity coverage columns. Recalculate it to plot coverage.");
    }
    const int x_bins = bin_count(request, "x_bins", 20);
    const int y_bins = bin_count(request, "y_bins", x_bins);
    const auto [x0, x1] = axis_range(request, "x_range");
    const auto [y0, y1] = axis_range(request, "y_range");
    int64_t max_points = request.value("max_points", json(20000)).get<int64_t>();
    if (max_points < 0 || max_points > 1000000) {
      throw std::invalid_argument("max_points must be between 0 and 1000000");
    }

    std::vector<int64_t> order = rows(request);
    std::sort(order.begin(), order.end());
    const auto xs = result.column_values(column);
    const auto ys = result.column_values(score);
    std::vector<double> x, y;
    x.reserve(order.size());
    y.reserve(order.size());
    for (int64_t row : order) {
      double a = numeric(xs[static_cast<std::size_t>(row)]);
      double b = numeric(ys[static_cast<std::size_t>(row)]);
      if (!std::isfinite(a) || !std::isfinite(b)) continue;
      x.push_back(a);
      y.push_back(b);
    }

    std::vector<int64_t> counts(static_cast<std::size_t>(x_bins) * y_bins, 0);
    auto bin_of = [](double v, double low, double high, int bins) {
      if (v < low || v > high) return -1;
      return std::min(bins - 1, static_cast<int>((v - low) / (high - low) * bins));
    };
    int64_t in_range = 0, above_bound = 0;
    for (std::size_t i = 0; i < x.size(); ++i) {
      if (y[i] > std::sqrt(std::max(0.0, x[i])) + 1e-6) ++above_bound;
      int bx = bin_of(x[i], x0, x1, x_bins), by = bin_of(y[i], y0, y1, y_bins);
      if (bx < 0 || by < 0) continue;
      ++counts[static_cast<std::size_t>(by) * x_bins + bx];
      ++in_range;
    }

    std::vector<std::size_t> picked(x.size());
    std::iota(picked.begin(), picked.end(), std::size_t{0});
    const bool sampled = static_cast<int64_t>(x.size()) > max_points;
    if (sampled) {
      std::mt19937_64 random(20261106);
      for (std::size_t i = 0; i < static_cast<std::size_t>(max_points); ++i) {
        std::uniform_int_distribution<std::size_t> pick(i, picked.size() - 1);
        std::swap(picked[i], picked[pick(random)]);
      }
      picked.resize(static_cast<std::size_t>(max_points));
      std::sort(picked.begin(), picked.end());
    }
    json px = json::array(), py = json::array();
    for (std::size_t i : picked) {
      px.push_back(x[i]);
      py.push_back(y[i]);
    }

    json parameters = metadata_.value("parameters", json::object());
    return {{"side", side},
            {"column", column},
            {"score", score},
            {"request_id", request.value("request_id", json())},
            {"total_rows", static_cast<int64_t>(order.size())},
            {"plotted_rows", static_cast<int64_t>(x.size())},
            {"in_range_rows", in_range},
            {"above_bound_rows", above_bound},
            {"x_bins", x_bins},
            {"y_bins", y_bins},
            {"x_range", {x0, x1}},
            {"y_range", {y0, y1}},
            {"counts", counts},
            {"points", {{"x", px}, {"y", py}}},
            {"sampled", sampled},
            {"intensity_exponent",
             parameters.is_object() ? parameters.value("intensity_exponent", json(1.0)) : json(1.0)},
            {"marginals", {{"x", kernel_density(x)}, {"y", kernel_density(y)}}}};
  }

  json match(int64_t row, const json& score) const {
    const auto& result = *result_;
    if (!result.has_matched_data()) {
      throw std::invalid_argument("This similarity result does not contain matched data");
    }
    if (row < 0 || row >= result.size()) throw std::out_of_range("row out of range");
    auto [first, second] = result.match_records(row);
    json sources = metadata_.value("sources", json::array());
    if (!sources.is_array()) sources = json::array();
    json payloads = json::array();
    int side = 0;
    for (const MSDataset* record : {&first, &second}) {
      std::string data_column = "data_index" + std::to_string(side + 1);
      int64_t data_index = std::get<int64_t>(result.column_values(data_column)[static_cast<std::size_t>(row)]);
      const auto& source_indices = side == 0 ? result.matched_source_indices()->first
                                             : result.matched_source_indices()->second;
      int64_t source_index = source_indices[static_cast<std::size_t>(data_index)];
      json source = side < static_cast<int>(sources.size()) && sources[side].is_object()
                        ? sources[side] : json::object();
      json metadata = json::object();
      std::string title;
      for (const auto& column : record->columns()) metadata[column] = to_json(record->value(0, column));
      // Column names are compared case-insensitively: uncanonicalized MSP/MGF
      // columns keep their source spelling (NAME, TITLE).
      const auto lower = [](std::string text) {
        std::transform(text.begin(), text.end(), text.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return text;
      };
      for (const char* key : {"name", "title", "specid", "id"}) {
        for (const auto& [column, value] : metadata.items()) {
          if (lower(column) == key && !value.is_null() && json_text(value) != "") {
            title = json_text(value);
            break;
          }
        }
        if (!title.empty()) break;
      }
      if (title.empty()) title = "Spectrum " + std::to_string(source_index + 1);
      std::string source_path = json_text(source.value("path", json("")));
      std::string name = utf8(from_utf8(source_path).filename());
      if (name.empty()) {
        name = source.contains("role") ? json_text(source["role"]) : "Dataset " + std::to_string(side + 1);
      }
      payloads.push_back({{"datasetName", name},
                          {"datasetPath", source_path},
                          {"globalIndex", source_index},
                          {"title", title},
                          {"columns", record->columns()},
                          {"row", metadata},
                          {"spectrum", spectrum_json(record->peaks().spectrum(0))}});
      ++side;
    }
    // The method the spectrum view starts with: the score column shown.
    return {{"query", payloads[0]},
            {"reference", payloads[1]},
            {"method", score_of({{"score", score}})}};
  }

  int64_t export_result(const json& request) const {
    std::vector<int64_t> order = rows(request);
    sim::SimilarityDataset view = view_of(order);
    fs::path path = from_utf8(json_text(request.at("path")));
    std::string suffix = fold_case(utf8(path.extension()));
    if (suffix == ".mssim") {
      json metadata = json::parse(view.metadata_json());
      metadata["row_count"] = view.size();
      metadata["export_view"] = {{"filters", request.value("filters", json::array())},
                                 {"sort", request.value("sort", json())},
                                 {"source_rows", result_->size()}};
      view.set_metadata_json(metadata.dump());
      view.save(utf8(path));
    } else if (suffix == ".parquet" || suffix == ".csv" || suffix == ".tsv") {
      view.export_table(utf8(path));
    } else {
      throw std::invalid_argument("Export format must be mssim, parquet, csv, or tsv");
    }
    return view.size();
  }
};

}  // namespace

int run_similarity_backend(const std::string& path, int page_size) {
  SimilarityBackend backend(path, std::max(1, page_size));
  return backend.run();
}

}  // namespace viewer
