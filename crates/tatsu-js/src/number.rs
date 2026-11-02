pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }

    let scientific = format!("{:e}", value.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp output always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().expect("LowerExp exponent is an integer");
    let digits = break_tie_to_even(value.abs(), digits, exponent);

    let k = digits.len() as i32;
    let n = exponent + 1;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exponent >= 0 { '+' } else { '-' });
        out.push_str(&exponent.abs().to_string());
    }
    out
}

fn break_tie_to_even(value: f64, digits: String, exponent: i32) -> String {
    let odd = digits.bytes().last().is_some_and(|d| (d - b'0') % 2 == 1);
    if !odd || digits.len() < 2 {
        return digits;
    }
    let exact = format!("{value:.780e}");
    let (mantissa, exact_exponent) = exact.split_once('e').expect("LowerExp has an exponent");
    if exact_exponent.parse::<i32>() != Ok(exponent) {
        return digits;
    }
    let exact_digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exact_digits = exact_digits.trim_end_matches('0');
    let k = digits.len();
    if exact_digits.len() != k + 1 || !exact_digits.ends_with('5') {
        return digits;
    }
    let lower = &exact_digits[..k];
    let lower_is_even = (lower.as_bytes()[k - 1] - b'0').is_multiple_of(2);
    let round_trips = format!("{}.{}e{exponent}", &lower[..1], &lower[1..])
        .parse::<f64>()
        .is_ok_and(|parsed| parsed == value);
    if lower_is_even && round_trips {
        lower.to_string()
    } else {
        digits
    }
}

#[cfg(test)]
mod tests {
    use super::number_to_string as js;

    #[test]
    fn number_integral_values_have_no_fraction() {
        assert_eq!(js(13.0), "13");
        assert_eq!(js(-42.0), "-42");
        assert_eq!(js(9_007_199_254_740_992.0), "9007199254740992");
        assert_eq!(js(18_014_398_509_481_984.0), "18014398509481984");
        assert_eq!(js(123_456_789_012_345_680_000.0), "123456789012345680000");
    }

    #[test]
    fn number_switches_to_exponent_form_at_1e21() {
        assert_eq!(js(1e21), "1e+21");
        assert_eq!(js(1.5e21), "1.5e+21");
        assert_eq!(js(-1e21), "-1e+21");
        assert_eq!(js(1e300), "1e+300");
        assert_eq!(js(f64::MAX), "1.7976931348623157e+308");
    }

    #[test]
    fn number_switches_to_exponent_form_below_1e_minus_6() {
        assert_eq!(js(1e-6), "0.000001");
        assert_eq!(js(1.5e-6), "0.0000015");
        assert_eq!(js(1e-7), "1e-7");
        assert_eq!(js(-1.5e-7), "-1.5e-7");
        assert_eq!(js(1.23e-18), "1.23e-18");
        assert_eq!(js(5e-324), "5e-324");
    }

    #[test]
    fn number_fractions_use_shortest_round_trip_digits() {
        assert_eq!(js(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js(0.1), "0.1");
        assert_eq!(js(2.5), "2.5");
        assert_eq!(js(-123.456), "-123.456");
    }

    #[test]
    fn number_ties_between_shortest_candidates_pick_the_even_digit() {
        let halfway = f64::from_bits(0x430b_ecdc_79e5_5fca);
        assert_eq!(js(halfway), "982532006652921.2");
        assert_eq!(js(-halfway), "-982532006652921.2");
    }

    #[test]
    fn number_negative_zero_is_zero() {
        assert_eq!(js(-0.0), "0");
        assert_eq!(js(0.0), "0");
    }

    #[test]
    fn number_non_finite_values_follow_js_to_string() {
        assert_eq!(js(f64::NAN), "NaN");
        assert_eq!(js(f64::INFINITY), "Infinity");
        assert_eq!(js(f64::NEG_INFINITY), "-Infinity");
    }
}
