#pragma once
// Configuration LovyanGFX de l'ESP32-2432S028 : écran SPI sur le bus HSPI, rétroéclairage PWM sur GPIO21.
//
// Le même nom de carte recouvre deux contrôleurs d'écran. Les versions USB-C (dont l'écran TPM408-2.8)
// embarquent un ST7789 : piloté par la séquence d'initialisation de l'ILI9341, il affiche en portrait et
// retourné quelle que soit la rotation demandée. Les premières versions micro-USB seules ont un ILI9341.
// La ligne HELLO publie l'identifiant lu (0xD3 = 0x009341 sur un ILI9341, 0 sur un ST7789).
//
// Le tactile résistif XPT2046 est sur un bus SPI séparé (VSPI : CLK 25, MOSI 32, MISO 39, CS 33, IRQ 36).
// Son orientation par rapport à l'écran varie selon les variantes de la carte : le firmware le calibre
// (touch_calibration.h) au lieu de supposer un sens.
#define LGFX_USE_V1
#include <LovyanGFX.hpp>

#ifndef MASCOTS_PANEL_ILI9341
#define MASCOTS_PANEL_ILI9341 0
#endif

#if MASCOTS_PANEL_ILI9341
using CydPanel = lgfx::Panel_ILI9341;
#else
using CydPanel = lgfx::Panel_ST7789;
#endif

class CydDisplay : public lgfx::LGFX_Device {
 public:
  CydDisplay() {
    auto bus = bus_.config();
    bus.spi_host = HSPI_HOST;
    bus.spi_mode = 0;
    bus.freq_write = 40000000;  // 55 MHz fonctionne souvent, 40 MHz fonctionne toujours.
    bus.freq_read = 16000000;
    bus.spi_3wire = false;
    bus.use_lock = true;
    bus.dma_channel = SPI_DMA_CH_AUTO;
    bus.pin_sclk = 14;
    bus.pin_mosi = 13;
    bus.pin_miso = 12;
    bus.pin_dc = 2;
    bus_.config(bus);
    panel_.setBus(&bus_);

    auto panel = panel_.config();
    panel.pin_cs = 15;
    panel.pin_rst = -1;  // reset câblé sur EN
    panel.pin_busy = -1;
    panel.panel_width = 240;
    panel.panel_height = 320;
    panel.readable = true;
    panel.invert = false;
    panel.rgb_order = false;
    panel.dlen_16bit = false;
    panel.bus_shared = false;
    panel_.config(panel);

    auto light = light_.config();
    light.pin_bl = 21;
    light.invert = false;
    light.freq = 44100;
    light.pwm_channel = 7;
    light_.config(light);
    panel_.setLight(&light_);

    // La configuration du tactile doit précéder setTouch : celui-ci en déduit la calibration par défaut.
    auto touch = touch_.config();
    touch.spi_host = VSPI_HOST;  // l'écran occupe HSPI : les deux bus ne se partagent rien
    touch.freq = 1000000;
    touch.pin_sclk = 25;
    touch.pin_mosi = 32;
    touch.pin_miso = 39;
    touch.pin_cs = 33;
    touch.pin_int = 36;
    touch.bus_shared = false;
    touch.offset_rotation = 0;
    // Calibration par défaut (avant toute calibration manuelle) : bornes brutes d'usine du XPT2046, axe X
    // inversé. Mesuré sur la variante ST7789 (TPM408-2.8) le 2026-10-24 : sans cette inversion, des taps
    // sur la flèche en haut à gauche arrivaient en bas à gauche (x juste, y ≈ 230 au lieu de ≈ 10).
    touch.x_min = 3900;
    touch.x_max = 300;
    touch.y_min = 400;
    touch.y_max = 3900;
    touch_.config(touch);
    panel_.setTouch(&touch_);

    setPanel(&panel_);
  }

  /** Dimensions natives du panneau (rotation 0), référence de la calibration tactile. */
  static constexpr int32_t NATIVE_WIDTH = 240;
  static constexpr int32_t NATIVE_HEIGHT = 320;

 private:
  CydPanel panel_;
  lgfx::Bus_SPI bus_;
  lgfx::Light_PWM light_;
  lgfx::Touch_XPT2046 touch_;
};
