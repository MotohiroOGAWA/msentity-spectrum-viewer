#include "view.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <unordered_set>

namespace viewer {

namespace {

double required_number(const json& value, const std::string& message) {
  if (value.is_number()) return value.get<double>();
  if (value.is_string()) {
    if (auto number = parse_number(value.get<std::string>())) return *number;
  }
  throw FilterError(message);
}

bool numeric_match(const std::string& op, double left, double right) {
  if (op == ">") return left > right;
  if (op == ">=") return left >= right;
  if (op == "<") return left < right;
  if (op == "<=") return left <= right;
  return left == right;  // numeric_eq
}

bool is_numeric_operator(const std::string& op) {
  return op == ">" || op == ">=" || op == "<" || op == "<=" || op == "numeric_eq";
}

Value filter_value(const json& value) {
  if (value.is_null()) return std::monostate{};
  if (value.is_boolean()) return value.get<bool>();
  if (value.is_number_integer()) return value.get<int64_t>();
  if (value.is_number()) return value.get<double>();
  return json_text(value);
}

msentity::FilterNode filter_node(const MSDataset& dataset, const json& value) {
  if (!value.is_object()) throw FilterError("Filter group children must be objects");
  if (value.contains("children")) {
    std::string logic = fold_case(json_text(value.value("logic", json("and"))));
    if (logic != "and" && logic != "or") throw FilterError("Filter group logic must be AND or OR");
    msentity::FilterGroup group;
    group.logic = logic == "and" ? msentity::FilterLogic::And : msentity::FilterLogic::Or;
    if (!value["children"].is_array()) throw FilterError("Filter group children must be an array");
    for (const auto& child : value["children"]) group.children.push_back(filter_node(dataset, child));
    return group;
  }
  std::string op = json_text(value.value("operator", json("text_eq")));
  msentity::FilterCondition condition;
  condition.column = json_text(value.value("column", json("")));
  condition.value = filter_value(value.value("value", json("")));
  if (op == "text_eq") condition.op = msentity::FilterOperator::TextEquals;
  else if (op == "!=") condition.op = msentity::FilterOperator::TextNotEquals;
  else if (op == "contains") condition.op = msentity::FilterOperator::Contains;
  else if (op == "numeric_eq") condition.op = msentity::FilterOperator::NumericEquals;
  else if (op == ">") condition.op = msentity::FilterOperator::Greater;
  else if (op == ">=") condition.op = msentity::FilterOperator::GreaterEqual;
  else if (op == "<") condition.op = msentity::FilterOperator::Less;
  else if (op == "<=") condition.op = msentity::FilterOperator::LessEqual;
  else if (op == "is_missing") condition.op = msentity::FilterOperator::IsMissing;
  else if (op == "is_not_missing") condition.op = msentity::FilterOperator::IsNotMissing;
  else if (op == "row_ids") {
    condition.op = msentity::FilterOperator::RowIds;
    for (const auto& id : value.value("row_ids", json::array())) if (id.is_number_integer()) condition.row_ids.push_back(id.get<int64_t>());
  } else if (op == "spectrum_peak" || op == "neutral_loss") {
    condition.op = op == "spectrum_peak" ? msentity::FilterOperator::SpectrumPeak : msentity::FilterOperator::NeutralLoss;
    try {
      condition.mz = required_number(value.value("mz", json()), "");
      condition.tolerance = required_number(value.value("tolerance", json()), "");
      condition.minimum_relative_intensity = value.contains("intensity") ? required_number(value["intensity"], "") : 0;
    } catch (const FilterError&) { throw FilterError("m/z, tolerance, and intensity must be numeric"); }
    condition.tolerance_ppm = fold_case(json_text(value.value("tolerance_unit", json("Da")))) == "ppm";
    condition.precursor_column = json_text(value.value("precursor_column", json("PrecursorMZ")));
  } else if (op == "smarts") throw FilterError("SMARTS filtering requires optional RDKit support");
  else throw FilterError("Unknown filter operator: " + op);
  if (condition.op != msentity::FilterOperator::RowIds &&
      condition.op != msentity::FilterOperator::SpectrumPeak &&
      condition.op != msentity::FilterOperator::NeutralLoss &&
      !dataset.has_column(condition.column)) throw FilterError("Unknown filter column: " + condition.column);
  return condition;
}

msentity::FilterGroup filter_group(const MSDataset& dataset, const json& filters) {
  if (filters.is_null()) return {};
  if (filters.is_array()) {
    msentity::FilterGroup group;
    for (const auto& item : filters) {
      if (!item.is_object()) continue;
      std::string column = json_text(item.value("column", json("")));
      std::string op = json_text(item.value("operator", json("text_eq")));
      json raw = item.value("value", json(""));
      // Preserve legacy behavior for incomplete flat rows.
      if (op != "row_ids" && op != "spectrum_peak" && op != "neutral_loss" &&
          op != "is_missing" && op != "is_not_missing" &&
          (!dataset.has_column(column) || raw.is_null() || json_text(raw).empty())) continue;
      group.children.push_back(filter_node(dataset, item));
    }
    return group;
  }
  auto node = filter_node(dataset, filters);
  if (auto* group = std::get_if<msentity::FilterGroup>(&node)) return *group;
  msentity::FilterGroup group;
  group.children.push_back(std::move(node));
  return group;
}

}  // namespace

std::vector<int64_t> sorted_positions(std::vector<int64_t> positions,
                                      const std::vector<std::vector<Value>>& keys,
                                      const std::vector<bool>& ascending) {
  std::stable_sort(positions.begin(), positions.end(), [&](int64_t a, int64_t b) {
    for (std::size_t k = 0; k < keys.size(); ++k) {
      const Value& x = keys[k][static_cast<std::size_t>(a)];
      const Value& y = keys[k][static_cast<std::size_t>(b)];
      bool mx = is_missing(x);
      bool my = is_missing(y);
      if (mx || my) {
        if (mx && my) continue;
        return my;  // missing values last in either direction
      }
      int order = compare_values(x, y);
      if (order != 0) return ascending[k] ? order < 0 : order > 0;
    }
    return false;
  });
  return positions;
}

MSDataset apply_dataset_view(const MSDataset& dataset, const json& filters, const json& sort,
                             const json& columns) {
  MSDataset view = dataset.slice(0, dataset.size());
  const auto& available = dataset.columns();
  auto has = [&](const std::string& column) {
    return std::find(available.begin(), available.end(), column) != available.end();
  };

  view = view.filter(filter_group(dataset, filters));

  json items = sort.is_object() ? json::array({sort}) : sort.is_array() ? sort : json::array();
  std::vector<std::vector<Value>> keys;
  std::vector<bool> ascending;
  std::vector<std::string> used;
  for (const auto& item : items) {
    if (!item.is_object()) continue;
    std::string column = json_text(item.value("column", json("")));
    if (!has(column) || std::find(used.begin(), used.end(), column) != used.end()) continue;
    used.push_back(column);
    keys.push_back(view.column_values(column));
    ascending.push_back(json_text(item.value("direction", json("asc"))) != "desc");
  }
  if (!keys.empty()) {
    std::vector<int64_t> positions(static_cast<std::size_t>(view.size()));
    std::iota(positions.begin(), positions.end(), 0);
    view = view.select(sorted_positions(std::move(positions), keys, ascending));
  }

  if (columns.is_array()) {
    std::vector<std::string> ordered;
    for (const auto& column : columns) {
      std::string name = json_text(column);
      if (has(name) && std::find(ordered.begin(), ordered.end(), name) == ordered.end()) {
        ordered.push_back(name);
      }
    }
    view.set_columns(ordered);
  }
  return view;
}

std::vector<int64_t> table_view_rows(
    int64_t n_rows, const std::vector<std::string>& columns,
    const std::function<std::vector<Value>(const std::string&)>& column_values,
    const json& filters, const json& sort) {
  std::vector<int64_t> rows(static_cast<std::size_t>(n_rows));
  std::iota(rows.begin(), rows.end(), 0);
  auto has = [&](const std::string& column) {
    return std::find(columns.begin(), columns.end(), column) != columns.end();
  };
  auto condition_mask = [&](const json& condition) {
    std::string column = json_text(condition.value("column", json("")));
    if (!has(column)) throw FilterError("Unknown filter column: " + column);
    std::string op = json_text(condition.value("operator", json("")));
    json raw = condition.value("value", json(""));
    auto values = column_values(column);
    std::vector<bool> mask(static_cast<std::size_t>(n_rows), false);
    if (is_numeric_operator(op)) {
      double right = required_number(raw, "Filter value must be numeric");
      if (!std::isfinite(right)) throw FilterError("Filter value must be finite");
      for (int64_t row = 0; row < n_rows; ++row) {
        auto left = numeric_value(values[static_cast<std::size_t>(row)]);
        mask[static_cast<std::size_t>(row)] = left && numeric_match(op, *left, right);
      }
    } else {
      if (op != "contains" && op != "text_eq" && op != "!=") {
        throw FilterError("Unknown filter operator: " + op);
      }
      std::string right = json_text(raw);
      std::string right_folded = fold_case(right);
      for (int64_t row = 0; row < n_rows; ++row) {
        std::string left = display_text(values[static_cast<std::size_t>(row)]);
        bool match = op == "contains" ? fold_case(left).find(right_folded) != std::string::npos
                     : op == "text_eq" ? left == right
                                       : left != right;
        mask[static_cast<std::size_t>(row)] = match;
      }
    }
    return mask;
  };
  std::function<std::vector<bool>(const json&)> evaluate = [&](const json& node) {
    if (!node.is_object() || !node.contains("children")) return condition_mask(node);
    std::string logic = fold_case(json_text(node.value("logic", json("and"))));
    if (logic != "and" && logic != "or") throw FilterError("Filter group logic must be AND or OR");
    if (!node["children"].is_array()) throw FilterError("Filter group children must be an array");
    std::vector<bool> result(static_cast<std::size_t>(n_rows), logic == "and");
    for (const auto& child : node["children"]) {
      auto child_mask = evaluate(child);
      for (std::size_t i = 0; i < result.size(); ++i) result[i] = logic == "and" ? result[i] && child_mask[i] : result[i] || child_mask[i];
    }
    return result;
  };
  json root = filters.is_array() ? json{{"logic", "and"}, {"children", filters}} : filters;
  if (!root.is_null()) {
    auto mask = evaluate(root);
    rows.erase(std::remove_if(rows.begin(), rows.end(), [&](int64_t row) { return !mask[static_cast<std::size_t>(row)]; }), rows.end());
  }
  if (sort.is_object() && sort.contains("column")) {
    std::string column = json_text(sort["column"]);
    if (!has(column)) throw FilterError("Unknown sort column: " + column);
    rows = sorted_positions(std::move(rows), {column_values(column)},
                            {json_text(sort.value("direction", json("asc"))) != "desc"});
  }
  return rows;
}

}  // namespace viewer
