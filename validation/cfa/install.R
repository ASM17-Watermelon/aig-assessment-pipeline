# CFA 의존성 설치 — CRAN 날짜 스냅샷(posit package manager)으로 패키지 버전을 고정한다.
# 같은 날짜 스냅샷 + 같은 R 마이너 버전이면 어디서 돌려도 같은 패키지 버전이 잡힌다(논문 결과: R 4.6.1 · lavaan 0.7.2).
SNAPSHOT <- Sys.getenv("CFA_CRAN_SNAPSHOT", "2026-09-01")
options(repos = c(CRAN = sprintf("https://packagemanager.posit.co/cran/%s", SNAPSHOT)))
pkgs <- c("lavaan", "jsonlite")
missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) install.packages(missing, quiet = TRUE)
for (p in pkgs) cat(sprintf("%s %s\n", p, as.character(packageVersion(p))))
cat(R.version.string, "\n")
cat("CRAN snapshot:", SNAPSHOT, "\n")
