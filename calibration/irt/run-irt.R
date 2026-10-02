#!/usr/bin/env Rscript
# 문항 보정 — 응답 스냅샷(실응답·가상 응답 공통 형식) → 역량별 1차원 2PL → 모수·적합·국소 독립·검사 정보.
# 역량 묶음은 인자로 받는다(요인 구조를 이 파일에 박지 않는다 — 구조가 바뀌어도 --groups 만 바꾼다).
#
# 사용: Rscript calibration/irt/run-irt.R --snapshot <dir> [--groups 1,2,3,4,5 | 1+5,2,3,4] [--out <dir>] [--cfa <cfa_result.json>]
#   --cfa 를 주면 같은 문항의 CFA 부하를 나란히 적는다(약한 문항 겹침 확인용).
# 출력: <out>/irt_items.csv · irt_families.csv · irt_tif.csv · irt_q3_flags.csv · irt_summary.json · irt_tif.png · irt_report.md

suppressPackageStartupMessages({
  library(mirt)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
opt <- list(snapshot = ".", groups = "1,2,3,4,5", out = NULL, cfa = NULL)
i <- 1L
while (i <= length(args)) {
  key <- sub("^--", "", args[[i]])
  if (key %in% names(opt) && i < length(args)) { opt[[key]] <- args[[i + 1L]]; i <- i + 2L } else { i <- i + 1L }
}
if (is.null(opt$out)) opt$out <- file.path(opt$snapshot, "irt")
dir.create(opt$out, showWarnings = FALSE, recursive = TRUE)

# 판정선: 변별도 = Baker(2001) 로지스틱 척도 구간(낮음 .35~.64 · 매우 낮음 < .35), 난이도 |b| > 3 = 극단,
# 적합 = S-X2(Orlando & Thissen 2000) BH 보정 p < .05, 국소 의존 = Q3 − 평균 Q3 > .20(Christensen et al. 2017).
CRITERIA <- list(a_low = 0.65, a_very_low = 0.35, b_extreme = 3, sx2_alpha = 0.05, q3_excess = 0.20,
                 info_precise = 4)  # 정보 4 = 조건부 SE .50 = 조건부 신뢰도 .75
DIM_NAMES <- c("위임 판단", "지시·소통", "산출물 비판적 검증", "안전·윤리", "적정 의존·주체성")
THETA <- seq(-4, 4, by = 0.1)

meta <- read.csv(file.path(opt$snapshot, "positions.csv"), stringsAsFactors = FALSE, na.strings = c("NA", ""))
wide <- read.csv(file.path(opt$snapshot, "responses_wide_family.csv"), check.names = FALSE, stringsAsFactors = FALSE, na.strings = c("NA", ""))
meta <- meta[meta$position_id %in% names(wide) & (is.na(meta$recalled_at) | meta$recalled_at == ""), ]

cfa <- if (!is.null(opt$cfa)) fromJSON(opt$cfa)$loadings else NULL
groups <- lapply(strsplit(strsplit(opt$groups, ",")[[1]], "\\+"), as.integer)
group_label <- function(g) paste0("D", g, collapse = "+")
group_name <- function(g) paste(DIM_NAMES[g], collapse = " + ")

item_rows <- list(); tif_rows <- list(); q3_rows <- list(); summ <- list()
for (g in groups) {
  lab <- group_label(g)
  m <- meta[meta$dimension %in% g, ]
  X <- as.matrix(wide[, m$position_id])
  storage.mode(X) <- "integer"

  m2 <- mirt(X, 1, itemtype = "2PL", SE = TRUE, verbose = FALSE)
  m1 <- mirt(X, 1, itemtype = "Rasch", verbose = FALSE)
  lrt <- anova(m1, m2, verbose = FALSE)

  pars <- coef(m2, IRTpars = TRUE, printSE = TRUE)
  ab <- t(sapply(m$position_id, function(id) c(pars[[id]]["par", c("a", "b")], pars[[id]]["SE", c("a", "b")])))
  colnames(ab) <- c("a", "b", "a_se", "b_se")
  lam <- summary(m2, verbose = FALSE)$rotF[, 1]
  # S-X2·M2 는 결측을 못 받는다 — 결측 있는 응답자는 적합 점검에서만 빼고(모수 추정은 전원 MML) 그 인원을 남긴다.
  n_fit <- sum(complete.cases(X))
  fit <- itemfit(m2, fit_stats = "S_X2", na.rm = anyNA(X))
  fit$p_bh <- p.adjust(fit$p.S_X2, "BH")
  p_obs <- colMeans(X, na.rm = TRUE)

  flag <- character(nrow(m))
  add <- function(sel, txt) flag[sel] <<- ifelse(flag[sel] == "", txt, paste(flag[sel], txt, sep = "; "))
  add(ab[, "a"] < CRITERIA$a_very_low, "변별 매우 낮음")
  add(ab[, "a"] >= CRITERIA$a_very_low & ab[, "a"] < CRITERIA$a_low, "변별 낮음")
  add(abs(ab[, "b"]) > CRITERIA$b_extreme, "난이도 극단")
  add(!is.na(fit$p_bh) & fit$p_bh < CRITERIA$sx2_alpha, "적합 미흡")

  cfa_l <- if (!is.null(cfa)) cfa$est[match(m$position_id, cfa$item)] else NA_real_
  item_rows[[lab]] <- data.frame(
    group = lab, position_id = m$position_id, family_code = m$family_code, dimension = m$dimension,
    p = round(p_obs, 4), a = round(ab[, "a"], 3), a_se = round(ab[, "a_se"], 3),
    b = round(ab[, "b"], 3), b_se = round(ab[, "b_se"], 3), loading = round(lam, 3), cfa_loading = round(cfa_l, 3),
    sx2 = round(fit$S_X2, 2), sx2_df = fit$df.S_X2, sx2_p = signif(fit$p.S_X2, 3), sx2_p_bh = signif(fit$p_bh, 3),
    flags = flag, stringsAsFactors = FALSE, row.names = NULL)

  q3 <- residuals(m2, type = "Q3", verbose = FALSE)
  off <- q3[upper.tri(q3)]
  q3_bar <- mean(off)
  idx <- which(upper.tri(q3), arr.ind = TRUE)
  pairs <- data.frame(group = lab, item1 = colnames(q3)[idx[, 1]], item2 = colnames(q3)[idx[, 2]], q3 = off, stringsAsFactors = FALSE)
  fam <- setNames(m$family_code, m$position_id)
  pairs$sibling <- fam[pairs$item1] == fam[pairs$item2]
  pairs$excess <- pairs$q3 - q3_bar
  q3_rows[[lab]] <- pairs[pairs$excess > CRITERIA$q3_excess | pairs$sibling, ]

  info <- testinfo(m2, matrix(THETA))
  tif_rows[[lab]] <- data.frame(group = lab, theta = THETA, info = round(info, 4), se = round(1 / sqrt(info), 4))
  precise <- THETA[info >= CRITERIA$info_precise]

  M2s <- tryCatch(M2(m2, na.rm = anyNA(X)), error = function(e) NULL)
  er <- fscores(m2, method = "EAP", returnER = TRUE)
  b_rho <- suppressWarnings(cor(ab[, "b"], p_obs, method = "spearman"))

  summ[[lab]] <- list(
    name = group_name(g), dimensions = g, n = nrow(X), n_fit = n_fit, items = ncol(X), converged = extract.mirt(m2, "converged"),
    logLik = extract.mirt(m2, "logLik"), lrt_rasch_vs_2pl = list(chisq = lrt$X2[2], df = lrt$df[2], p = lrt$p[2],
                                                                 aic_rasch = lrt$AIC[1], aic_2pl = lrt$AIC[2]),
    m2 = if (is.null(M2s)) NULL else as.list(M2s[1, intersect(names(M2s), c("M2", "df", "p", "RMSEA", "SRMSR", "TLI", "CFI"))]),
    marginal_rxx = marginal_rxx(m2), empirical_rxx = unname(er),
    a = as.list(summary(ab[, "a"])), b = as.list(summary(ab[, "b"])),
    spearman_b_vs_p = b_rho,
    flagged = sum(flag != ""), sx2_misfit = sum(!is.na(fit$p_bh) & fit$p_bh < CRITERIA$sx2_alpha),
    q3_mean = q3_bar, q3_flag_pairs = sum(pairs$excess > CRITERIA$q3_excess),
    sibling_pairs = sum(pairs$sibling), sibling_q3_mean = if (any(pairs$sibling)) mean(pairs$q3[pairs$sibling]) else NA,
    info_peak_theta = THETA[which.max(info)], info_peak = max(info),
    precise_range = if (length(precise)) range(precise) else NULL)
}

items <- do.call(rbind, item_rows)
# 문항모형(패밀리) 단위 요약 — 새 변형(씨앗 문항)의 사전 난이도(b 평균·SD)와, 문항모형 안 난이도 편차로 동형성 판단(편차가 크면 변형별 보정)
fam <- do.call(rbind, lapply(split(items, items$family_code), function(d) data.frame(
  group = d$group[1], family_code = d$family_code[1], positions = nrow(d),
  b_mean = round(mean(d$b), 3), b_sd = if (nrow(d) > 1) round(sd(d$b), 3) else NA_real_,
  a_mean = round(mean(d$a), 3), flagged = sum(d$flags != ""), stringsAsFactors = FALSE)))
fam <- fam[order(fam$group, fam$family_code), ]
write.csv(fam, file.path(opt$out, "irt_families.csv"), row.names = FALSE)
tif <- do.call(rbind, tif_rows)
q3f <- do.call(rbind, q3_rows)
write.csv(items, file.path(opt$out, "irt_items.csv"), row.names = FALSE)
write.csv(tif, file.path(opt$out, "irt_tif.csv"), row.names = FALSE)
write.csv(q3f, file.path(opt$out, "irt_q3_flags.csv"), row.names = FALSE)
write_json(list(snapshot = opt$snapshot, groups = opt$groups, model = "2PL (역량별 1차원, MML-EM)",
                criteria = CRITERIA, r_version = R.version.string, mirt_version = as.character(packageVersion("mirt")),
                groups_result = summ, rho_b_vs_p_all = cor(items$b, items$p, method = "spearman")),
           file.path(opt$out, "irt_summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = 4, null = "null")

png(file.path(opt$out, "irt_tif.png"), width = 1600, height = 900, res = 160)
par(mfrow = c(1, 2), mar = c(4.2, 4.2, 2.5, 1))
cols <- c("#3B5BA5", "#D1495B", "#2E933C", "#E8A33D", "#7A4FA3")[seq_along(groups)]
labs <- vapply(groups, group_label, "")
plot(NA, xlim = range(THETA), ylim = c(0, max(tif$info) * 1.05), xlab = "theta", ylab = "Test information", main = "Test information")
for (k in seq_along(labs)) with(tif[tif$group == labs[k], ], lines(theta, info, col = cols[k], lwd = 2))
abline(h = CRITERIA$info_precise, lty = 3, col = "grey40")
legend("topright", legend = labs, col = cols, lwd = 2, bty = "n")
plot(NA, xlim = range(THETA), ylim = c(0, 1.5), xlab = "theta", ylab = "Conditional SE", main = "Conditional SE")
for (k in seq_along(labs)) with(tif[tif$group == labs[k], ], lines(theta, se, col = cols[k], lwd = 2))
abline(h = 1 / sqrt(CRITERIA$info_precise), lty = 3, col = "grey40")
invisible(dev.off())

# ── 보고서 (부록 초안) ──
f <- function(x, d = 2) formatC(x, format = "f", digits = d)
L <- c(sprintf("# 문항 보정(2PL) 결과 — %s", basename(normalizePath(opt$snapshot))), "",
       sprintf("- 모형: 역량별 1차원 2PL, MML-EM (mirt %s, %s)", packageVersion("mirt"), R.version.string),
       sprintf("- 역량 묶음: `%s`", opt$groups), sprintf("- 응답자 %d명", nrow(wide)),
       if (any(vapply(summ, function(s) s$n_fit < s$n, logical(1))))
         sprintf("- 적합 점검(S-X2·M2)은 결측 없는 응답자만: %s", paste(sprintf("%s %d명", names(summ), vapply(summ, `[[`, 0L, "n_fit")), collapse = " · ")),
       "",
       "## 역량별 요약", "",
       "| 역량 | 문항 | Rasch 대비 2PL (Δχ², df, p) | AIC 우세 | M2 RMSEA · CFI | 주변 신뢰도 | a 중앙값 (범위) | b 범위 | b ↔ 정답률 순위 상관 | 정보 최고점 θ | 정보 ≥ 4 구간 | 플래그 문항 |",
       "|---|---|---|---|---|---|---|---|---|---|---|---|")
for (lab in names(summ)) {
  s <- summ[[lab]]
  rng <- if (is.null(s$precise_range)) "없음" else sprintf("%s ~ %s", f(s$precise_range[1], 1), f(s$precise_range[2], 1))
  m2txt <- if (is.null(s$m2)) "NA" else sprintf("%s · %s", f(s$m2$RMSEA, 3), f(s$m2$CFI, 3))
  aic_win <- if (s$lrt_rasch_vs_2pl$aic_2pl < s$lrt_rasch_vs_2pl$aic_rasch) "2PL" else "Rasch"
  L <- c(L, sprintf("| %s %s | %d | %s, %d, %s | %s | %s | %s | %s (%s~%s) | %s~%s | %s | %s | %s | %d |",
                    lab, s$name, s$items, f(s$lrt_rasch_vs_2pl$chisq, 1), as.integer(s$lrt_rasch_vs_2pl$df),
                    format.pval(s$lrt_rasch_vs_2pl$p, digits = 2, eps = 1e-4), aic_win, m2txt, f(s$marginal_rxx),
                    f(s$a$Median), f(s$a$Min.), f(s$a$Max.), f(s$b$Min.), f(s$b$Max.), f(s$spearman_b_vs_p),
                    f(s$info_peak_theta, 1), rng, s$flagged))
}
L <- c(L, "", "## 플래그 문항", "", "| 역량 | 위치 | 정답률 | a (SE) | b (SE) | 2PL 부하 | CFA 부하 | S-X2 p(BH) | 사유 |", "|---|---|---|---|---|---|---|---|---|")
fl <- items[items$flags != "", ]
for (r in seq_len(nrow(fl))) with(fl[r, ], L <<- c(L, sprintf("| %s | %s | %s | %s (%s) | %s (%s) | %s | %s | %s | %s |",
  group, position_id, f(p), f(a), f(a_se), f(b), f(b_se), f(loading), ifelse(is.na(cfa_loading), "-", f(cfa_loading)),
  format.pval(sx2_p_bh, digits = 2), flags)))
L <- c(L, "", "## 국소 독립(Q3)", "", "| 역량 | 평균 Q3 | 초과(> 평균 + .20) 쌍 | 같은 문항모형 쌍 | 같은 문항모형 쌍 평균 Q3 |", "|---|---|---|---|---|")
for (lab in names(summ)) with(summ[[lab]], L <<- c(L, sprintf("| %s | %s | %d | %d | %s |", lab, f(q3_mean, 3), q3_flag_pairs, sibling_pairs,
  ifelse(is.na(sibling_q3_mean), "-", f(sibling_q3_mean, 3)))))
L <- c(L, "", "## 문항모형(패밀리) 단위 난이도", "", "| 역량 | 문항모형 | 위치 수 | b 평균 | b SD | a 평균 | 플래그 |", "|---|---|---|---|---|---|---|")
for (r in seq_len(nrow(fam))) with(fam[r, ], L <<- c(L, sprintf("| %s | %s | %d | %s | %s | %s | %d |",
  group, family_code, positions, f(b_mean), ifelse(is.na(b_sd), "-", f(b_sd)), f(a_mean), flagged)))
writeLines(L, file.path(opt$out, "irt_report.md"))
cat(paste(L, collapse = "\n"), "\n")
