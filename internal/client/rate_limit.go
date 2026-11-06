package client

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"
)

// RateLimitInfo is safe retry metadata shared by API failures and MCP tool
// errors. Durations are seconds from the response, never absolute timestamps.
type RateLimitInfo struct {
	Limit             string `json:"limit"`
	RetryAfterSeconds int    `json:"retry_after_seconds"`
	Capacity          int    `json:"capacity"`
	Remaining         int    `json:"remaining"`
	ResetAfterSeconds int    `json:"reset_after_seconds"`
}

// RateLimitError retains an ordinary command failure for exit-code handling
// while carrying retry metadata through nested batch and staging errors.
type RateLimitError struct {
	RateLimit RateLimitInfo
	failure   *Fail
}

func (e *RateLimitError) Error() string { return e.failure.Error() }
func (e *RateLimitError) Unwrap() error { return e.failure }

func responseRateLimit(method, path string, status int, data any, headers http.Header) *RateLimitError {
	response := data
	if status != http.StatusTooManyRequests {
		if path != "/api/batch" || status < 400 {
			return nil
		}
		requests, _ := dig(data, "data", "requests").(map[string]any)
		response = nil
		for _, entry := range requests {
			candidate, _ := dig(entry, "response").(map[string]any)
			if code, ok := asInt(candidate["status"]); ok && code == http.StatusTooManyRequests {
				response = candidate
				break
			}
		}
		if response == nil {
			return nil
		}
	}
	// Older servers omit retry metadata. A conservative hint is explicitly
	// identified as unknown rather than inventing which server rule fired. Ten
	// seconds covers the legacy default API windows; it is a client fallback,
	// not an observed server cooldown.
	info := RateLimitInfo{Limit: "unknown", RetryAfterSeconds: 10, ResetAfterSeconds: 10}
	metadata := dig(response, "data", "rate_limit")
	if metadata == nil {
		metadata = dig(data, "data", "rate_limit")
	}
	if metadata != nil {
		if raw, err := json.Marshal(metadata); err == nil {
			_ = json.Unmarshal(raw, &info)
		}
	}
	if value := headers.Get("Retry-After"); value != "" {
		if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
			info.RetryAfterSeconds = seconds
		} else if deadline, err := http.ParseTime(value); err == nil {
			info.RetryAfterSeconds = int(math.Ceil(time.Until(deadline).Seconds()))
		}
	}
	for name, target := range map[string]*int{
		"RateLimit-Limit": &info.Capacity, "RateLimit-Remaining": &info.Remaining, "RateLimit-Reset": &info.ResetAfterSeconds,
	} {
		if n, err := strconv.Atoi(headers.Get(name)); err == nil && n >= 0 {
			*target = n
		}
	}
	if info.RetryAfterSeconds < 1 {
		info.RetryAfterSeconds = 1
	}
	if info.ResetAfterSeconds < info.RetryAfterSeconds {
		info.ResetAfterSeconds = info.RetryAfterSeconds
	}
	message := fmt.Sprintf("HTTP 429 from %s %s: rate limit %s reached. Retry after %d seconds.", method, path, info.Limit, info.RetryAfterSeconds)
	if path == "/api/batch" {
		message += " Nothing in this batch was saved."
	}
	return &RateLimitError{RateLimit: info, failure: &Fail{1, message}}
}
