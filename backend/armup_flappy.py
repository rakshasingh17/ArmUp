"""Flappy Bird-style neck exercise overlay for ArmUp.

A completed Owl Neck Tilt repetition starts the game. The tracked head
height directly controls the owl's vertical position. This module contains
only game state and rendering; it does not know anything about pose tracking
or scoring.
"""
import random
import time
import cv2
import numpy as np


class FlappyGame:
    def __init__(self, width=310, height=230, seed=None):
        self.width = width
        self.height = height
        self.random = random.Random(seed)
        self.best_score = 0
        self.reset()

    def reset(self):
        self.bird_x = 70.0
        self.bird_y = self.height * 0.46
        self.velocity = 0.0
        self.control_y = 0.0
        self.score = 0
        self.started = False
        self.dead = False
        self.dead_at = 0.0
        # Start forgiving, then become more engaging as the player scores.
        self.pipe_speed = 88.0
        self.pipe_width = 42
        self.gap = 108
        self.base_gap = 108
        self.min_gap = 88
        self.next_gap_center = self.height * 0.50
        self.pipes = []
        self._spawn_pipe(self.width + 30)
        self._spawn_pipe(self.width + 190)

    def _spawn_pipe(self, x):
        margin = 28
        # Alternate the preferred height so the player must move both up and
        # down instead of being able to stay in one comfortable position.
        center = self.height * 0.50
        shift = self.random.choice((-34, -22, 22, 34))
        gap_center = max(margin + self.gap / 2,
                         min(self.height - margin - self.gap / 2,
                             self.next_gap_center + shift))
        self.next_gap_center = gap_center
        gap_top = int(gap_center - self.gap / 2)
        self.pipes.append({"x": float(x), "gap_top": gap_top, "passed": False})

    def start(self):
        """Start or restart without requiring a sideways neck movement."""
        if self.dead:
            self.reset()
        self.started = True
        self.bird_y = self.height * 0.50

    # Kept as a compatibility alias for older app code.
    def flap(self):
        self.start()

    def set_vertical_control(self, amount):
        """Set desired vertical position from -1 (up) to +1 (down)."""
        self.control_y = max(-1.0, min(1.0, float(amount)))

    def update(self, dt):
        dt = min(max(float(dt), 0.0), 0.05)
        if self.dead:
            if time.time() - self.dead_at > 1.2:
                self.reset()
            return
        if not self.started:
            self.bird_y = self.height * 0.46 + np.sin(time.time() * 3.0) * 5
            return

        # Keep the entire usable control range inside the safe play area.
        target_y = self.height * 0.50 + self.control_y * 62.0
        target_y = max(52.0, min(self.height - 52.0, target_y))
        # Smooth the response so small tracking noise does not jerk the owl.
        response = min(1.0, dt * 7.0)
        self.bird_y += (target_y - self.bird_y) * response
        for pipe in self.pipes:
            pipe["x"] -= self.pipe_speed * dt
            if not pipe["passed"] and pipe["x"] + self.pipe_width < self.bird_x:
                pipe["passed"] = True
                self.score += 1
                self.best_score = max(self.best_score, self.score)
                # Gradual challenge: slightly faster pipes and smaller gaps,
                # never below the rehabilitation-friendly minimum.
                self.gap = max(self.min_gap, self.base_gap - (self.score // 2) * 4)
                self.pipe_speed = min(118.0, 88.0 + (self.score // 2) * 5)

        if self.pipes and self.pipes[0]["x"] < -self.pipe_width:
            self.pipes.pop(0)
        if not self.pipes or self.pipes[-1]["x"] < self.width - 145:
            self._spawn_pipe(self.width + 15)

        if self.bird_y - 10 < 24 or self.bird_y + 10 > self.height - 22:
            self._die()
            return
        for pipe in self.pipes:
            within_x = self.bird_x + 10 > pipe["x"] and self.bird_x - 10 < pipe["x"] + self.pipe_width
            outside_gap = self.bird_y - 10 < pipe["gap_top"] or self.bird_y + 10 > pipe["gap_top"] + self.gap
            if within_x and outside_gap:
                self._die()
                return

    def _die(self):
        self.dead = True
        self.dead_at = time.time()
        self.best_score = max(self.best_score, self.score)

    def draw(self, canvas, x, y):
        h, w = canvas.shape[:2]
        x = max(0, min(int(x), w - self.width))
        y = max(0, min(int(y), h - self.height))
        panel = canvas[y:y + self.height, x:x + self.width]
        if panel.shape[0] != self.height or panel.shape[1] != self.width:
            return canvas

        # Night-sky panel with a subtle translucent card treatment.
        overlay = panel.copy()
        cv2.rectangle(overlay, (0, 0), (self.width, self.height), (33, 22, 55), -1)
        cv2.addWeighted(overlay, 0.90, panel, 0.10, 0, panel)
        cv2.rectangle(panel, (0, 0), (self.width - 1, self.height - 1), (213, 224, 94), 2, cv2.LINE_AA)

        # Moon, stars, and ground.
        cv2.circle(panel, (self.width - 38, 35), 16, (210, 220, 155), -1, cv2.LINE_AA)
        cv2.circle(panel, (self.width - 32, 30), 16, (33, 22, 55), -1, cv2.LINE_AA)
        for sx, sy in ((24, 34), (128, 22), (202, 48), (270, 78), (166, 90)):
            cv2.circle(panel, (sx, sy), 1, (196, 168, 154), -1, cv2.LINE_AA)

        # Branch-like pipes.
        for pipe in self.pipes:
            px = int(pipe["x"])
            top = int(pipe["gap_top"])
            bottom = top + self.gap
            green = (94, 180, 112)
            dark = (45, 110, 75)
            cv2.rectangle(panel, (px, 24), (px + self.pipe_width, top), green, -1)
            cv2.rectangle(panel, (px - 4, top - 9), (px + self.pipe_width + 4, top), dark, -1)
            cv2.rectangle(panel, (px, bottom), (px + self.pipe_width, self.height - 23), green, -1)
            cv2.rectangle(panel, (px - 4, bottom), (px + self.pipe_width + 4, bottom + 9), dark, -1)

        # Ground.
        cv2.rectangle(panel, (0, self.height - 22), (self.width, self.height), (65, 43, 48), -1)
        for gx in range(-10, self.width, 24):
            cv2.line(panel, (gx, self.height - 22), (gx + 12, self.height), (105, 75, 65), 2)

        # Owl bird: body, wing, eye, and beak.
        bx, by = int(self.bird_x), int(self.bird_y)
        cv2.ellipse(panel, (bx, by), (15, 12), 0, 0, 360, (213, 224, 94), -1, cv2.LINE_AA)
        cv2.ellipse(panel, (bx - 5, by + 5), (10, 5), -20, 0, 360, (178, 150, 65), -1, cv2.LINE_AA)
        cv2.circle(panel, (bx + 7, by - 5), 5, (245, 245, 235), -1, cv2.LINE_AA)
        cv2.circle(panel, (bx + 8, by - 5), 2, (32, 22, 38), -1, cv2.LINE_AA)
        cv2.fillPoly(panel, [np.array([(bx + 14, by - 1), (bx + 24, by + 3), (bx + 14, by + 6)])], (94, 193, 255))
        cv2.line(panel, (bx - 8, by - 10), (bx - 12, by - 17), (213, 224, 94), 2)
        cv2.line(panel, (bx + 1, by - 11), (bx + 5, by - 18), (213, 224, 94), 2)

        cv2.putText(panel, f"OWL  {self.score}", (12, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (250, 246, 243), 1, cv2.LINE_AA)
        if not self.started:
            cv2.putText(panel, "Move head up / down", (82, 108), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (250, 246, 243), 1, cv2.LINE_AA)
            cv2.putText(panel, "to follow the gaps", (95, 130), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (196, 168, 154), 1, cv2.LINE_AA)
        elif self.dead:
            cv2.putText(panel, "Nice try!", (112, 112), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (250, 246, 243), 2, cv2.LINE_AA)
            cv2.putText(panel, "Next tilt restarts", (77, 136), cv2.FONT_HERSHEY_SIMPLEX, 0.39, (196, 168, 154), 1, cv2.LINE_AA)
        cv2.putText(panel, f"BEST {self.best_score}", (self.width - 80, self.height - 7), cv2.FONT_HERSHEY_SIMPLEX, 0.34, (196, 168, 154), 1, cv2.LINE_AA)
        canvas[y:y + self.height, x:x + self.width] = panel
        return canvas
