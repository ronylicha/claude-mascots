#include "format.h"

#include <stdio.h>

namespace format {

namespace {

struct Unit {
  int64_t size;
  char suffix;
};

constexpr Unit UNITS[] = {{1000LL, 'k'}, {1000000LL, 'M'}, {1000000000LL, 'G'}, {1000000000000LL, 'T'}};
constexpr int64_t TENTHS_LIMIT = 10000;  // 999.9 est le plus grand affichage avant de passer à l'unité suivante

}  // namespace

void compact(char* out, size_t size, int64_t value) {
  if (value < 0) {
    snprintf(out, size, "?");
    return;
  }
  if (value < 1000) {
    snprintf(out, size, "%lld", static_cast<long long>(value));
    return;
  }
  // Arrondi au dixième dans chaque unité ; 999 950 devient « 1.0M » et non « 1000.0k ».
  for (const Unit& unit : UNITS) {
    const int64_t tenths = (value * 10 + unit.size / 2) / unit.size;
    if (tenths < TENTHS_LIMIT || &unit == &UNITS[sizeof(UNITS) / sizeof(UNITS[0]) - 1]) {
      snprintf(out, size, "%lld.%lld%c", static_cast<long long>(tenths / 10), static_cast<long long>(tenths % 10), unit.suffix);
      return;
    }
  }
}

void duration(char* out, size_t size, int32_t minutes) {
  if (minutes < 0) {
    snprintf(out, size, "?");
  } else if (minutes >= 1440) {
    snprintf(out, size, "%ldj%02ldh", static_cast<long>(minutes / 1440), static_cast<long>((minutes % 1440) / 60));
  } else if (minutes >= 60) {
    snprintf(out, size, "%ldh%02ld", static_cast<long>(minutes / 60), static_cast<long>(minutes % 60));
  } else {
    snprintf(out, size, "%ldmin", static_cast<long>(minutes));
  }
}

void elapsed(char* out, size_t size, int32_t seconds) {
  if (seconds < 0) {
    snprintf(out, size, "?");
  } else if (seconds >= 86400) {
    snprintf(out, size, "%ldj", static_cast<long>(seconds / 86400));
  } else if (seconds >= 3600) {
    snprintf(out, size, "%ldh", static_cast<long>(seconds / 3600));
  } else if (seconds >= 60) {
    snprintf(out, size, "%ldmin", static_cast<long>(seconds / 60));
  } else {
    snprintf(out, size, "%lds", static_cast<long>(seconds));
  }
}

void money(char* out, size_t size, int32_t cents) {
  if (cents < 0) {
    snprintf(out, size, "-");
    return;
  }
  snprintf(out, size, "$%ld.%02ld", static_cast<long>(cents / 100), static_cast<long>(cents % 100));
}

}  // namespace format
