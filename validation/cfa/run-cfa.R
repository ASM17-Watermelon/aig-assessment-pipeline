#!/usr/bin/env Rscript
# 자동 검증 게이트 — 응답 스냅샷 → CFA(WLSMV · ordered) → cfa_result.json + 판정(pass / fail / hold).
# 입력 = 스냅샷 디렉토리(실데이터·가상 응답 공통 형식), 출력 = <out> JSON. 판정 임계 = 아래 CRITERIA(사전 고정).
#
# 사용: Rscript validation/cfa/run-cfa.R --snapshot <dir> [--model five|four|one | --groups 1+5,2,3,4]
#         [--level position|variant] [--subset all|anchors] [--missing listwise|pairwise]
#         [--compare true] [--compare-groups 1+5,2,3,4] [--out <file>]
#   level position = 문항모형×소재 위치 열(responses_wide_family.csv, 회전 변형을 접은 것 — 문항모형 단위)
#   level variant  = 변형 열(responses_wide.csv). 회전이 있으면 subset=anchors 로만 성립한다(비앵커는 co-observation 0).
#   groups         = 요인 구조를 인자로 준다. 쉼표 = 요인, + = 한 요인으로 묶을 차원(예 1+5,2,3,4 = 4요인, D1·D5 통합).
#                    요인 이름은 D + 차원 번호를 이어 쓴 것(D15·D2·D3·D4). 주면 --model 은 무시된다.
#   model four     = D2+D5 병합(일부러 틀린 모형) · one = 1요인(일부러 틀린 모형) — 합성 통과 시험의 불합격 확인용.
#   compare true   = 내포 비교(척도 보정 Δχ² · ΔCFI). five 는 four(D2+D5)·one 과, groups 는 one 과 비교한다.
#   compare-groups = 지금 모형을 이 묶음으로 합친 모형과도 비교한다(예: five 대 1+5,2,3,4 — 합쳐도 적합 손실이 없는지).

suppressPackageStartupMessages({
  library(lavaan)
  library(jsonlite)
})
`%||%` <- function(a, b) if (is.null(a)) b else a  # R < 4.4 호환

args <- commandArgs(trailingOnly = TRUE)
opt <- list(snapshot = ".", model = "five", groups = NULL, level = "position", subset = "all", missing = "listwise", out = NULL, compare = "false", `compare-groups` = NULL)
i <- 1L
while (i <= length(args)) {
  key <- sub("^--", "", args[[i]])
  if (key %in% names(opt) && i < length(args)) { opt[[key]] <- args[[i + 1L]]; i <- i + 2L } else { i <- i + 1L }
}
parse_groups <- function(spec) lapply(strsplit(strsplit(spec, ",")[[1]], "\\+"), as.integer)
groups_tag <- function(spec) paste0("g", gsub(",", "-", gsub("\\+", "", spec)))
if (!is.null(opt$groups)) opt$model <- groups_tag(opt$groups)
if (is.null(opt$out)) opt$out <- file.path(opt$snapshot, sprintf("cfa_result_%s_%s_%s_%s.json", opt$model, opt$level, opt$subset, opt$missing))

# 판정 규칙(게이트) = CFI/TLI ≥ .90 · RMSEA ≤ .08 · 요인 상관 추정치 < .85(Kline 2016 관례, 95% 상한은 보고) · 요인당 지표 ≥ 4 · n ≥ 200.
# SRMR 은 보고 지표 — 이분 60문항에서 표본오차로 부풀어(합성 실측 n300 .081·n200 .100·n500 .064) 참모형을 떨어뜨렸다. 참고선 = n<500 .10 / n≥500 .08. WRMR < 1.0 참고.
CRITERIA <- list(
  cfi = 0.90, tli = 0.90, rmsea = 0.08, srmr_small_n = 0.10, srmr_large_n = 0.08, srmr_n_split = 500, wrmr = 1.0,
  loading_min = 0.40, factor_corr_max = 0.85, min_n = 200,
  item_drop_loading = 0.30, extreme_p = c(0.10, 0.90), min_items_per_dim = 4
)

started <- Sys.time()
read_snapshot <- function() {
  if (opt$level == "position") {
    meta <- read.csv(file.path(opt$snapshot, "positions.csv"), stringsAsFactors = FALSE, na.strings = c("NA", ""))
    meta$id <- meta$position_id
    wide <- read.csv(file.path(opt$snapshot, "responses_wide_family.csv"), check.names = FALSE, stringsAsFactors = FALSE, na.strings = c("NA", ""))
  } else {
    meta <- read.csv(file.path(opt$snapshot, "items.csv"), stringsAsFactors = FALSE, na.strings = c("NA", ""))
    meta$id <- meta$analysis_item_id
    wide <- read.csv(file.path(opt$snapshot, "responses_wide.csv"), check.names = FALSE, stringsAsFactors = FALSE, na.strings = c("NA", ""))
  }
  list(meta = meta, wide = wide)
}
snap <- read_snapshot()
meta <- snap$meta
wide <- snap$wide
truth <- tryCatch(fromJSON(file.path(opt$snapshot, "truth.json"), simplifyVector = FALSE), error = function(e) NULL)

# ── 지표 선별: 회수 안 됨 · 극단 p(.10 / .90 밖) 아님 · (subset) 앵커만 ──
keep <- meta$id %in% names(wide)
keep <- keep & (is.na(meta$recalled_at) | meta$recalled_at == "")
keep <- keep & !is.na(meta$p_correct) & meta$p_correct >= CRITERIA$extreme_p[1] & meta$p_correct <= CRITERIA$extreme_p[2]
if (opt$subset == "anchors") keep <- keep & (as.character(meta$is_anchor) %in% c("true", "TRUE", "1"))
meta <- meta[keep, ]
ids <- meta$id
dim_of <- as.integer(meta$dimension)
# lavaan 0.7 파서는 백틱·하이픈 변수명을 거부한다(CI 실측 2026-09-29) — 안전한 이름으로 적합하고 결과에서 원래 id 로 되돌린다.
safe <- setNames(sprintf("i%03d", seq_along(ids)), ids)
unsafe <- function(x) ifelse(x %in% safe, names(safe)[match(x, safe)], x)
per_dim <- as.integer(table(factor(dim_of, levels = 1:5)))

q <- function(x) unname(safe[x])
ind <- function(sel) paste(q(ids[sel]), collapse = " + ")
build_model <- function(kind) {
  if (startsWith(kind, "groups:")) {
    gs <- parse_groups(sub("^groups:", "", kind))
    m <- paste0(vapply(gs, function(g) paste0("D", paste(g, collapse = ""), " =~ ", ind(dim_of %in% g)), ""), collapse = "\n")
    m <- paste0(m, "\n")
  } else m <- switch(kind,
    five = paste0("D1 =~ ", ind(dim_of == 1), "\nD2 =~ ", ind(dim_of == 2), "\nD3 =~ ", ind(dim_of == 3),
                  "\nD4 =~ ", ind(dim_of == 4), "\nD5 =~ ", ind(dim_of == 5), "\n"),
    four = paste0("D1 =~ ", ind(dim_of == 1), "\nD25 =~ ", ind(dim_of %in% c(2L, 5L)), "\nD3 =~ ", ind(dim_of == 3),
                  "\nD4 =~ ", ind(dim_of == 4), "\n"),
    one  = paste0("G =~ ", ind(rep(TRUE, length(ids))), "\n"),
    stop("unknown model"))
  # 같은 문항모형(family_code) 형제 쌍의 잔차 상관만 허용 — 위치 수준에서만(변형 수준은 co-observation 0)
  if (opt$level == "position" && "family_code" %in% names(meta)) {
    groups <- split(ids, meta$family_code)
    for (grp in groups) if (length(grp) >= 2) {
      pairs <- combn(grp, 2)
      m <- paste0(m, paste0(q(pairs[1, ]), " ~~ ", q(pairs[2, ]), collapse = "\n"), "\n")
    }
  }
  m
}
main_kind <- if (!is.null(opt$groups)) paste0("groups:", opt$groups) else opt$model
model_syntax <- build_model(main_kind)

data <- wide[, c("user_hash", ids), drop = FALSE]
names(data) <- c("user_hash", unname(safe[ids]))
for (c in unname(safe)) data[[c]] <- as.integer(data[[c]])
n_total <- nrow(data)
n_complete <- sum(stats::complete.cases(data[, unname(safe), drop = FALSE]))

result <- list(
  snapshot = opt$snapshot, model = opt$model, groups = if (is.null(opt$groups)) NA else opt$groups, level = opt$level, subset = opt$subset, missing = opt$missing,
  criteria = CRITERIA, items_used = length(ids), per_dimension = per_dim, n_total = n_total, n_complete = n_complete,
  r_version = R.version.string, lavaan_version = as.character(packageVersion("lavaan")), started_at = format(started, "%Y-%m-%dT%H:%M:%S%z")
)

fit_model <- function(syntax) cfa(syntax, data = data, ordered = unname(safe), estimator = "WLSMV", missing = opt$missing, std.lv = TRUE)
fit <- tryCatch(fit_model(model_syntax), error = function(e) e)

if (inherits(fit, "error")) {
  result$error <- conditionMessage(fit)
  result$verdict <- list(status = "error")
  cat("ERROR:", substr(gsub("\\s+", " ", result$error), 1, 300), "\n")
} else {
  fm <- tryCatch(fitMeasures(fit, c("chisq.scaled", "df", "pvalue.scaled", "cfi.scaled", "tli.scaled", "rmsea.scaled", "rmsea.ci.upper.scaled", "srmr")),
                 error = function(e) fitMeasures(fit, c("chisq", "df", "pvalue", "cfi", "tli", "rmsea", "rmsea.ci.upper", "srmr")))
  names(fm) <- sub("\\.scaled$", "", names(fm))
  fm[["wrmr"]] <- tryCatch(unname(fitMeasures(fit, "wrmr")), error = function(e) NA_real_)  # 범주형 전용 잔차 지표(Yu 2002: < 1.0)
  n_used <- lavInspect(fit, "nobs")
  std <- standardizedSolution(fit)
  loadings <- std[std$op == "=~", c("lhs", "rhs", "est.std", "se", "pvalue")]
  names(loadings) <- c("factor", "item", "est", "se", "pvalue")
  loadings$item <- unsafe(loadings$item)
  latents <- unique(loadings$factor)
  corr <- std[std$op == "~~" & std$lhs != std$rhs & std$lhs %in% latents & std$rhs %in% latents, c("lhs", "rhs", "est.std", "se", "ci.upper")]
  names(corr) <- c("f1", "f2", "est", "se", "ci_upper")
  mi <- tryCatch({ m <- modindices(fit, sort. = TRUE); m <- head(m[, c("lhs", "op", "rhs", "mi")], 10); m$lhs <- unsafe(m$lhs); m$rhs <- unsafe(m$rhs); m }, error = function(e) NULL)

  weak <- loadings$item[loadings$est < CRITERIA$loading_min | is.na(loadings$pvalue) | loadings$pvalue > 0.05]
  drop <- loadings$item[loadings$est < CRITERIA$item_drop_loading]
  # SRMR 은 이분 60문항·n≈300 에서 표본오차로 .08 을 넘긴다(합성 실측) — 핵심(CFI·TLI·RMSEA)과 분리해 보고한다.
  fit_ok_core <- isTRUE(fm[["cfi"]] >= CRITERIA$cfi && fm[["tli"]] >= CRITERIA$tli && fm[["rmsea"]] <= CRITERIA$rmsea)
  srmr_line <- if (n_used >= CRITERIA$srmr_n_split) CRITERIA$srmr_large_n else CRITERIA$srmr_small_n
  srmr_ok <- isTRUE(fm[["srmr"]] <= srmr_line)          # 보고용 — 게이트 아님
  wrmr_ok <- isTRUE(!is.na(fm[["wrmr"]]) && fm[["wrmr"]] < CRITERIA$wrmr)
  fit_ok <- fit_ok_core
  # 판별타당: 요인 상관 추정치가 .85 미만(Kline 2016 관례, 95% 상한은 factor_corr 에 그대로 남겨 보고). 병합 모형과의 비교는 민감도 보고(rejected 여부)이지 게이트가 아니다.
  discriminant_ok <- if (nrow(corr)) all(abs(corr$est) < CRITERIA$factor_corr_max) else TRUE
  per_factor <- if (!is.null(opt$groups)) vapply(parse_groups(opt$groups), function(g) sum(dim_of %in% g), 0L) else per_dim
  dims_ok <- all(per_factor >= CRITERIA$min_items_per_dim) || !(opt$model == "five" || !is.null(opt$groups))
  n_ok <- n_used >= CRITERIA$min_n
  status <- if (!n_ok) "hold" else if (fit_ok && discriminant_ok && dims_ok) "pass" else "fail"

  # 진값 복원(합성 데이터일 때만): 부하 MAE·최대 오차, 요인 상관 MAE (5요인일 때)
  recovery <- NULL
  if (!is.null(truth) && opt$model == "five") {
    tl <- if (opt$level == "position") setNames(sapply(truth$positions, function(p) p$loading), sapply(truth$positions, function(p) p$position_id)) else
      setNames(unlist(lapply(truth$positions, function(p) sapply(p$variants, function(v) v$loading))), unlist(lapply(truth$positions, function(p) sapply(p$variants, function(v) paste0(v$itemId, "@v1")))))
    got <- loadings$est; names(got) <- loadings$item
    common <- intersect(names(got), names(tl))
    err <- got[common] - tl[common]
    phi <- do.call(rbind, lapply(truth$phi, unlist))
    corr_err <- if (nrow(corr)) mapply(function(a, b, e) e - phi[as.integer(sub("D", "", a)), as.integer(sub("D", "", b))], corr$f1, corr$f2, corr$est) else numeric(0)
    recovery <- list(items_compared = length(common), loading_mae = mean(abs(err)), loading_max_abs_err = max(abs(err)), loading_bias = mean(err),
                     corr_mae = if (length(corr_err)) mean(abs(corr_err)) else NA)
  }

  result$fit <- as.list(fm)
  result$loadings <- loadings
  result$factor_corr <- corr
  result$modindices_top10 <- mi
  result$recovery <- recovery
  # 내포 모형 비교 — 병합 모형·1요인은 절대 적합만으론 안 걸러진다(합성 실측: four CFI .98). 척도 보정 Δχ²(lavTestLRT)·ΔCFI 로 판정.
  comparison <- NULL
  if ((opt$model == "five" || !is.null(opt$groups)) && (identical(opt$compare, "true") || !is.null(opt$`compare-groups`))) {
    cmp_one <- function(kind) tryCatch({
      f2 <- fit_model(build_model(kind))
      lrt <- lavTestLRT(fit, f2)
      cfi2 <- tryCatch(unname(fitMeasures(f2, "cfi.scaled")), error = function(e) unname(fitMeasures(f2, "cfi")))
      list(model = kind, chisq_diff = unname(lrt[2, "Chisq diff"]), df_diff = unname(lrt[2, "Df diff"]), pvalue = unname(lrt[2, "Pr(>Chisq)"]),
           cfi = cfi2, delta_cfi = fm[["cfi"]] - cfi2, rejected = isTRUE(unname(lrt[2, "Pr(>Chisq)"]) < 0.05 && (fm[["cfi"]] - cfi2) >= 0.01))
    }, error = function(e) list(model = kind, error = conditionMessage(e)))
    comparison <- list()
    if (identical(opt$compare, "true")) comparison <- if (is.null(opt$groups)) list(four = cmp_one("four"), one = cmp_one("one")) else list(one = cmp_one("one"))
    if (!is.null(opt$`compare-groups`)) { comparison$merged <- cmp_one(paste0("groups:", opt$`compare-groups`)); comparison$merged$groups <- opt$`compare-groups` }
  }
  result$comparison <- comparison
  result$verdict <- list(status = status, n_used = n_used, n_ok = n_ok, fit_ok = fit_ok, fit_ok_core = fit_ok_core, srmr_ok = srmr_ok, srmr_line = srmr_line, wrmr_ok = wrmr_ok, discriminant_ok = discriminant_ok, dims_ok = dims_ok,
                         weak_items = weak, drop_items = drop, efa_fallback_candidate = (n_ok && !fit_ok),
                         converged = lavInspect(fit, "converged"))
}
result$elapsed_sec <- as.numeric(difftime(Sys.time(), started, units = "secs"))
write_json(result, opt$out, auto_unbox = TRUE, pretty = TRUE, digits = 4, na = "null")
cat(sprintf("[%s/%s/%s/%s] status=%s core=%s srmr=%s n=%s items=%d cfi=%s rmsea=%s srmr=%s wrmr=%s → %s\n", opt$model, opt$level, opt$subset, opt$missing,
            result$verdict$status, result$verdict$fit_ok_core %||% NA, result$verdict$srmr_ok %||% NA, result$verdict$n_used %||% NA, length(ids),
            if (!is.null(result$fit)) round(result$fit$cfi, 3) else NA, if (!is.null(result$fit)) round(result$fit$rmsea, 3) else NA,
            if (!is.null(result$fit)) round(result$fit$srmr, 3) else NA, if (!is.null(result$fit)) round(result$fit$wrmr, 3) else NA, opt$out))
