// Table filters and sorting requested by the viewer UI.
#pragma once

#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

#include "json_support.hpp"

namespace viewer {

// An error in a filter or sort the user entered (reported as "filter-error").
class FilterError : public std::invalid_argument {
 public:
  using std::invalid_argument::invalid_argument;
};

// Dataset table view: `filters` (conditions, all must hold), `sort` (one
// {column, direction} or a list in priority order), and `columns` (visible
// columns in order; null keeps them). Condition operators:
//   text_eq, !=, contains          case-insensitive text comparison
//   numeric_eq, >, >=, <, <=       numeric comparison (non-numbers never match)
//   spectrum_peak, neutral_loss    peak within m/z tolerance (Da or ppm) and
//                                  relative intensity
//   row_ids                        rows whose row id is listed (resolved SMARTS filters)
//   smarts                         rejected: the host resolves it to row_ids
// Conditions on unknown columns or with an empty value are ignored.
MSDataset apply_dataset_view(const MSDataset& dataset, const json& filters, const json& sort,
                             const json& columns = nullptr);

// Decode the similarity viewer's protocol into a library filter.
msentity::FilterGroup similarity_filter_group(const json& filters);

// Positions sorted by several keys (stable; missing values last).
std::vector<int64_t> sorted_positions(std::vector<int64_t> positions,
                                      const std::vector<std::vector<Value>>& keys,
                                      const std::vector<bool>& ascending);

}  // namespace viewer
