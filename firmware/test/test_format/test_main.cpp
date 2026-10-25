// Tests de la mise en forme des nombres, exécutés sur PC : pio test -e native
#include <unity.h>

#include "format.h"

namespace {

const char* compact(int64_t value) {
  static char buffer[16];
  format::compact(buffer, sizeof(buffer), value);
  return buffer;
}

const char* duration(int32_t minutes) {
  static char buffer[16];
  format::duration(buffer, sizeof(buffer), minutes);
  return buffer;
}

const char* elapsed(int32_t seconds) {
  static char buffer[16];
  format::elapsed(buffer, sizeof(buffer), seconds);
  return buffer;
}

const char* money(int32_t cents) {
  static char buffer[16];
  format::money(buffer, sizeof(buffer), cents);
  return buffer;
}

}  // namespace

void setUp() {}
void tearDown() {}

void test_compact_keeps_small_numbers_whole() {
  TEST_ASSERT_EQUAL_STRING("0", compact(0));
  TEST_ASSERT_EQUAL_STRING("999", compact(999));
}

void test_compact_uses_one_decimal_per_unit() {
  TEST_ASSERT_EQUAL_STRING("1.0k", compact(1000));
  TEST_ASSERT_EQUAL_STRING("12.3k", compact(12345));
  TEST_ASSERT_EQUAL_STRING("4.5M", compact(4500000));
  TEST_ASSERT_EQUAL_STRING("15.0M", compact(15022918));
  TEST_ASSERT_EQUAL_STRING("1.5G", compact(1500000000LL));
}

void test_compact_carries_to_next_unit_when_rounding_overflows() {
  TEST_ASSERT_EQUAL_STRING("999.9k", compact(999900));
  TEST_ASSERT_EQUAL_STRING("1.0M", compact(999950));
  TEST_ASSERT_EQUAL_STRING("1.0G", compact(999950000));
}

void test_compact_handles_values_beyond_32_bits() {
  TEST_ASSERT_EQUAL_STRING("3.0G", compact(2999999999LL + 1));
  TEST_ASSERT_EQUAL_STRING("12.3T", compact(12345000000000LL));
}

void test_compact_marks_negative_as_unknown() { TEST_ASSERT_EQUAL_STRING("?", compact(-1)); }

void test_duration_switches_unit() {
  TEST_ASSERT_EQUAL_STRING("12min", duration(12));
  TEST_ASSERT_EQUAL_STRING("1h35", duration(95));
  TEST_ASSERT_EQUAL_STRING("2j03h", duration(2 * 1440 + 3 * 60 + 7));
  TEST_ASSERT_EQUAL_STRING("?", duration(-1));
}

void test_elapsed_switches_unit() {
  TEST_ASSERT_EQUAL_STRING("4s", elapsed(4));
  TEST_ASSERT_EQUAL_STRING("3min", elapsed(200));
  TEST_ASSERT_EQUAL_STRING("2h", elapsed(7300));
  TEST_ASSERT_EQUAL_STRING("5j", elapsed(5 * 86400));
  TEST_ASSERT_EQUAL_STRING("?", elapsed(-1));
}

void test_money_formats_cents() {
  TEST_ASSERT_EQUAL_STRING("$3.07", money(307));
  TEST_ASSERT_EQUAL_STRING("$0.05", money(5));
  TEST_ASSERT_EQUAL_STRING("-", money(-1));
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_compact_keeps_small_numbers_whole);
  RUN_TEST(test_compact_uses_one_decimal_per_unit);
  RUN_TEST(test_compact_carries_to_next_unit_when_rounding_overflows);
  RUN_TEST(test_compact_handles_values_beyond_32_bits);
  RUN_TEST(test_compact_marks_negative_as_unknown);
  RUN_TEST(test_duration_switches_unit);
  RUN_TEST(test_elapsed_switches_unit);
  RUN_TEST(test_money_formats_cents);
  return UNITY_END();
}
