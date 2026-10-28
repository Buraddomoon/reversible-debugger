def reverse_text(text):
    reversed_text = ""
    i = len(text) - 1
    while i >= 0:
        reversed_text += text[i]
        i -= 1
    return reversed_text

word = "maçã🚀"
result = reverse_text(word)
print("Invertido:", result)
