# IRT 보정 의존성 — CFA(validation/cfa/install.R)와 같은 CRAN 날짜 스냅샷으로 버전을 고정한다. mirt 빌드에 cmake 가 필요할 수 있다(RcppParallel).
SNAPSHOT <- Sys.getenv("CFA_CRAN_SNAPSHOT", "2026-09-01")
options(repos = c(CRAN = sprintf("https://packagemanager.posit.co/cran/%s", SNAPSHOT)))
pkgs <- c("mirt", "jsonlite")
missing <- pkgs[!vapply(pkgs, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing)) install.packages(missing, quiet = TRUE, Ncpus = 4)
for (p in pkgs) cat(sprintf("%s %s\n", p, as.character(packageVersion(p))))
cat(R.version.string, "\n")
cat("CRAN snapshot:", SNAPSHOT, "\n")
