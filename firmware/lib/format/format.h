#pragma once
// Mise en forme ASCII des nombres pour le petit écran. Aucune dépendance Arduino : testé sur PC (pio test -e native).
#include <stddef.h>
#include <stdint.h>

namespace format {

/** Nombre court à une décimale : 999, 1.2k, 12.3k, 4.5M, 1.2G. Négatif : "?". */
void compact(char* out, size_t size, int64_t value);

/** Durée en minutes : "12min", "1h35", "2j03h". Négatif : "?". */
void duration(char* out, size_t size, int32_t minutes);

/** Âge en secondes : "4s", "3min", "2h", "5j". Négatif : "?". */
void elapsed(char* out, size_t size, int32_t seconds);

/** Montant en centimes : "$3.07". Négatif (inconnu) : "-". */
void money(char* out, size_t size, int32_t cents);

}  // namespace format
